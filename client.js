const mediasoup = require('mediasoup-client');
const socketClient = require('socket.io-client');
const socketPromise = require('./lib/socket.io-promise').promise;
const config = require('./config');

const hostname = window.location.hostname;

let device;
let socket;
let producer;
let producerAudio;

const $ = document.querySelector.bind(document);
const $fsPublish = $('#fs_publish');
const $fsSubscribe = $('#fs_subscribe');
const $btnConnect = $('#btn_connect');
const $btnWebcam = $('#btn_webcam');
const $btnScreen = $('#btn_screen');
const $btnSubscribe = $('#btn_subscribe');
// const $chkSimulcast = $('#chk_simulcast');
const $txtConnection = $('#connection_status');
const $txtWebcam = $('#webcam_status');
const $txtScreen = $('#screen_status');
const $txtSubscription = $('#sub_status');
let $txtPublish;

const $audioInputSelect = $('#audioSource');
const $audioOutputSelect = $('#audioOutput');
const $videoSelect = $('#videoSource');

// $btnConnect.addEventListener('click', connect);
$btnWebcam.addEventListener('click', publish);
$btnScreen.addEventListener('click', publish);
// $btnSubscribe.addEventListener('click', subscribe);

if (typeof navigator.mediaDevices.getDisplayMedia === 'undefined') {
  $txtScreen.innerHTML = 'Not supported';
  $btnScreen.disabled = true;
}

// run "on-page-load" routines
connect();

navigator.mediaDevices.enumerateDevices().then(gotDevices).catch(handleError);

// declarations

async function connect() {
  // $btnConnect.disabled = true;
  $txtConnection.innerHTML = 'Connecting...';

  const queryString = window.location.search;
  const urlParams = new URLSearchParams(queryString);
  const q = urlParams.toString();

  console.log('my query', q);

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
    // $txtConnection.innerHTML = 'Connected';
    $fsPublish.disabled = false;
    // $fsSubscribe.disabled = false;

    const data = await socket.request('getRouterRtpCapabilities');
    await loadDevice(data);
  });

  socket.on('disconnect', () => {
    $txtConnection.innerHTML = 'Disconnected';
    // $btnConnect.disabled = false;
    // $fsPublish.disabled = true;
    // $fsSubscribe.disabled = true;
  });

  socket.on('connect_error', (error) => {
    console.error('could not connect to %s%s (%s)', serverUrl, opts.path, error.message);
    $txtConnection.innerHTML = 'Connection failed';
    // $btnConnect.disabled = false;
  });

  socket.on('newProducer', () => {
    // $fsSubscribe.disabled = false;
  });

  socket.on('admit', (name, id) => {
     console.log('admitted', name, id);
     $txtConnection.innerHTML = 'Connected as '+name+' (id '+id+')';
  });

  socket.on('newClient', (name, id) => {
      console.log('new client', name, id);
  });

  socket.on('clientDisconnected', (id) => {
     console.log('client disconnected', id);
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

  const transport = device.createSendTransport(data);
  transport.on('connect', async ({ dtlsParameters }, callback, errback) => {
    socket.request('connectProducerTransport', { dtlsParameters })
      .then(callback)
      .catch(errback);
  });

  transport.on('produce', async ({ kind, rtpParameters }, callback, errback) => {
    try {

        console.log('produce', kind);

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
        $fsPublish.disabled = true;
        $fsSubscribe.disabled = true;
      break;

      case 'connected':
        document.querySelector('#local_video').srcObject = stream;
        $txtPublish.innerHTML = 'published';
        $fsPublish.disabled = true;
        $fsSubscribe.disabled = false;
      break;

      case 'failed':
        transport.close();
        $txtPublish.innerHTML = 'failed';
        $fsPublish.disabled = false;
        $fsSubscribe.disabled = true;
      break;

      default: break;
    }
  });

  let stream;
  try {
    stream = await getUserMedia(transport, isWebcam);
    let track = stream.getVideoTracks()[0];
    const params = { track };

    // if ($chkSimulcast.checked)
    { // setup simulcast
      params.encodings = [
        { maxBitrate: 100000 },
        { maxBitrate: 300000 },
        { maxBitrate: 900000 },
      ];
      params.codecOptions = {
        videoGoogleStartBitrate : 1000
      };
    }

    producer = await transport.produce(params);
    track = stream.getAudioTracks()[0];

    const audioParams = { track };
    producerAudio = await transport.produce(audioParams);
  } catch (err) {
      console.log('failed to create producer', err);
    $txtPublish.innerHTML = 'failed';
  }
}

async function getUserMedia(transport, isWebcam) {
  if (!device.canProduce('video')) {
    console.error('cannot produce video');
    return;
  }

  // if (typeof stream !== 'undefined') 
  //     stream.getTracks().forEach(track => {
  //       track.stop();
  //     });

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

    // navigator.mediaDevices.enumerateDevices();
    navigator.mediaDevices.enumerateDevices().then(gotDevices).catch(handleError);
  }
  catch (err) {
    console.error('getUserMedia() failed:', err.message);
    throw err;
  }
  return stream;
}

async function subscribe() {
  const data = await socket.request('createConsumerTransport', {
    forceTcp: false,
  });
  if (data.error) {
    console.error(data.error);
    return;
  }

  const transport = device.createRecvTransport(data);
  transport.on('connect', ({ dtlsParameters }, callback, errback) => {
    socket.request('connectConsumerTransport', {
      transportId: transport.id,
      dtlsParameters
    })
      .then(callback)
      .catch(errback);
  });

  transport.on('connectionstatechange', async (state) => {
    switch (state) {
      case 'connecting':
        $txtSubscription.innerHTML = 'subscribing...';
        $fsSubscribe.disabled = true;
        break;

      case 'connected':
        console.log('connected!');

        document.querySelector('#remote_video').srcObject = await stream;
        await socket.request('resume');
        $txtSubscription.innerHTML = 'subscribed';
        $fsSubscribe.disabled = true;
        break;

      case 'failed':
        transport.close();
        $txtSubscription.innerHTML = 'failed';
        $fsSubscribe.disabled = false;
        break;

      default:
        console.log('transport state ', state);
      break;
    }
  });

  const stream = makeMediaStream(transport);
}

async function makeMediaStream(transport) {
    let videoTrack = await consume(transport, 'video');
    let audioTrack = await consume(transport, 'audio');

    const stream = new MediaStream();
    stream.addTrack(videoTrack);
    stream.addTrack(audioTrack);

    return stream;
}

async function consume(transport, mediaType) {
  const { rtpCapabilities } = device;
  const data = await socket.request((mediaType == 'video' ? 'consume' : 'consumeAudio'), { rtpCapabilities });

  console.log('data on consume reply. media type', mediaType, data);

  const {
    producerId,
    id,
    kind,
    rtpParameters,
  } = data;

  let codecOptions = {};
  const consumer = await transport.consume({
    id,
    producerId,
    kind,
    rtpParameters,
    codecOptions,
  });

  // let stream;
  // if (!stream)
  // {
  //   console.log('create new media stream');
  //   stream = new MediaStream();
  // }
  //
  // console.log('add track to stream', consumer.track);
  //
  // stream.addTrack(consumer.track);

  console.log('return track', consumer.track);

  return consumer.track;
}

function gotDevices(deviceInfos) {
  const selectors = [$audioInputSelect, $audioOutputSelect, $videoSelect];
  // Handles being called several times to update labels. Preserve values.
  const values = selectors.map(select => select ? select.value : null);
  selectors.forEach(select => {
    while (select && select.firstChild) {
      select.removeChild(select.firstChild);
    }
  });

  console.log('loaded devices GO', deviceInfos);

  for (let i = 0; i !== deviceInfos.length; ++i) {
    const deviceInfo = deviceInfos[i];
    const option = document.createElement('option');
    option.value = deviceInfo.deviceId;
    if (deviceInfo.kind === 'audioinput') {
        if ($audioInputSelect)
        {
            option.text = deviceInfo.label || `microphone ${$audioInputSelect.length + 1}`;
            $audioInputSelect.appendChild(option);
        }
    } else if (deviceInfo.kind === 'audiooutput') {
        if ($audioOutputSelect)
        {
            option.text = deviceInfo.label || `speaker ${$audioOutputSelect.length + 1}`;
            $audioOutputSelect.appendChild(option);
        }
    } else if (deviceInfo.kind === 'videoinput') {
        if ($videoSelect)
        {
            option.text = deviceInfo.label || `camera ${$videoSelect.length + 1}`;
            $videoSelect.appendChild(option);
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
