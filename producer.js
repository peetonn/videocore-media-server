const mediasoup = require('mediasoup-client');
const socketClient = require('socket.io-client');
const socketPromise = require('./lib/socket.io-promise').promise;
const config = require('./config');
const Cookies = require('js-cookie');

const hostname = window.location.hostname;
const queryString = window.location.search;
const urlParams = new URLSearchParams(queryString);

let device;
let socket;
let transport;
let producer;
let producerAudio;
let stream;

const $ = document.querySelector.bind(document);
const $fsPublish = $('#fs_publish');

const $btnWebcam = $('#btn_webcam');
const $txtConnection = $('#connection_status');
const $txtWebcam = $('#webcam_status');
const $txtScreen = $('#screen_status');
let $txtPublish;

const $audioInputSelect = $('#audioSource');
const $videoSelect = $('#videoSource');

$audioInputSelect.onchange = function (){
    console.log('aight');
    Cookies.set('videoCoreAudioInput', $audioInputSelect.value);
}

$videoSelect.onchange = function (){
    console.log('aight go');
    Cookies.set('videoCoreVideoInput', $videoSelect.value);
}

$btnWebcam.addEventListener('click', publish);

// run "on-page-load" routines
connect();
navigator.mediaDevices.enumerateDevices().then(gotDevices).catch(handleError);

async function connect() {
  $txtConnection.innerHTML = 'Connecting...';

  const q = urlParams.toString();
  const opts = {
    path: '/server',
    transports: ['websocket'],
    reconnectionDelayMax: 10000,
    query: q
  };

  const serverUrl = `https://${hostname}:${config.listenPort}`;
  socket = socketClient(serverUrl, opts);
  socket.request = socketPromise(socket);

  socket.on('connect', async () => {
    $fsPublish.disabled = false;

    const data = await socket.request('getRouterRtpCapabilities');
    await loadDevice(data);
  });

  socket.on('disconnect', () => {
    $txtConnection.innerHTML = 'Disconnected';
    $fsPublish.disabled = true;
  });

  socket.on('connect_error', (error) => {
    console.error('could not connect to %s%s (%s)', serverUrl, opts.path, error.message);
    $txtConnection.innerHTML = 'Connection failed';
  });

  socket.on('admit', (d) => {
     const {name , id} = d;
     console.log('admitted', name, id);
     $txtConnection.innerHTML = 'Connected as '+name+' (id '+id+')';
  });
}

async function loadDevice(routerRtpCapabilities) {
  try {
    device = new mediasoup.Device();
  } catch (error) {
    if (error.name === 'UnsupportedError') {
      console.error('browser not supported');
    }
  }
  await device.load({ routerRtpCapabilities });
}

async function publish(e) {
  const isWebcam = (e.target.id === 'btn_webcam');
  $txtPublish = isWebcam ? $txtWebcam : $txtScreen;

  const data = await socket.request('createProducerTransport', {
    forceTcp: false,
    rtpCapabilities: device.rtpCapabilities,
  });
  if (data.error) {
    console.error(data.error);
    return;
  }

  // check if this is re-publish
  if (typeof transport !== 'undefined' || transport )
    transport.close();
  transport = createTransport(data);

  if (typeof stream !== 'undefined' || stream)
     stream.getTracks().forEach(track => {
         track.stop();
     });

  try {
    stream = await getUserMedia(isWebcam);

    let track = stream.getVideoTracks()[0];
    const params = { track };
    params.encodings = [
        { maxBitrate: 100000 },
        { maxBitrate: 300000 },
        { maxBitrate: 900000 },
      ];
    params.codecOptions = {
        videoGoogleStartBitrate : 1000
      };

    if (producer)
        closeProducer(producer);
    producer = await transport.produce(params);

    track = stream.getAudioTracks()[0];
    const audioParams = { track };

    if (producerAudio)
        closeProducer(producerAudio);
    producerAudio = await transport.produce(audioParams);
  }
  catch (err) {
    console.log('failed to create producer', err);
    $txtPublish.innerHTML = 'failed';
  }
}

function createTransport(data) {
    let transport = device.createSendTransport(data);

    transport.on('connect', async ({ dtlsParameters }, callback, errback) => {
      socket.request('connectProducerTransport', { dtlsParameters })
        .then(callback)
        .catch(errback);
    });

    transport.on('produce', async ({ kind, rtpParameters }, callback, errback) => {
      try {
        const { id } = await socket.request('produce', {
          transportId: transport.id,
          kind,
          rtpParameters,
        });
        callback({ id });
      } catch (err) {
        errback(err);
      }
    });

    transport.on('connectionstatechange', (state) => {
      switch (state) {
        case 'connecting':
          $txtPublish.innerHTML = 'publishing...';
        break;

        case 'connected':
          document.querySelector('#local_video').srcObject = stream;
          $txtPublish.innerHTML = 'published';
        break;

        case 'failed':
          transport.close();
          $txtPublish.innerHTML = 'failed';
        break;

        default: break;
      }
    });

    return transport;
}

function closeProducer(producer) {
    producer.close();
}

async function getUserMedia(isWebcam) {
  if (!device.canProduce('video')) {
    console.error('cannot produce video');
    return;
  }

  let stream;

  try {
      const audioSource = $audioInputSelect.value;
      const videoSource = $videoSelect.value;
      const constraints = isWebcam ? {
          audio: {deviceId: audioSource ? {exact: audioSource} : undefined},
          video: {deviceId: videoSource ? {exact: videoSource} : undefined}
      } :
      {
          audio: {deviceId: audioSource ? {exact: audioSource} : undefined},
          video: true
      };

    stream = isWebcam ?
      await navigator.mediaDevices.getUserMedia(constraints) :
      await navigator.mediaDevices.getDisplayMedia(constraints);

    navigator.mediaDevices.enumerateDevices().then(gotDevices).catch(handleError);
  }
  catch (err) {
    console.error('getUserMedia() failed:', err.message);
    throw err;
  }

  return stream;
}

function gotDevices(deviceInfos) {
  const selectors = [$audioInputSelect, $videoSelect];

  // Handles being called several times to update labels. Preserve values.
  const values = selectors.map(select => select ? select.value : null);
  selectors.forEach(select => {
    while (select && select.firstChild) {
      select.removeChild(select.firstChild);
    }
  });

  for (let i = 0; i !== deviceInfos.length; ++i) {
    const deviceInfo = deviceInfos[i];
    const option = document.createElement('option');
    option.value = deviceInfo.deviceId;

    if (deviceInfo.kind === 'audioinput')
    {
        if ($audioInputSelect)
        {
            option.text = deviceInfo.label || `microphone ${$audioInputSelect.length + 1}`;
            $audioInputSelect.appendChild(option);

            if (option.value == Cookies.get('videoCoreAudioInput'))
                $audioInputSelect.value = deviceInfo.deviceId;
        }
    }
    else if (deviceInfo.kind === 'videoinput')
    {
        if ($videoSelect)
        {
            option.text = deviceInfo.label || `camera ${$videoSelect.length + 1}`;
            $videoSelect.appendChild(option);

            if (option.value == Cookies.get('videoCoreVideoInput'))
                $videoSelect.value = deviceInfo.deviceId;
        }
    } else {
      console.log('Some other kind of source/device: ', deviceInfo);
    }
  }

  selectors.forEach((select, selectorIndex) => {
    if (select && Array.prototype.slice.call(select.childNodes).some(n => n.value === values[selectorIndex])) {
        select.value = values[selectorIndex];
    }
  });
}

function handleError(error) {
  console.log('navigator.MediaDevices.getUserMedia error: ', error.message, error.name);
}
