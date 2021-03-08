const mediasoup = require('mediasoup-client');
const socketClient = require('socket.io-client');
const socketPromise = require('./lib/socket.io-promise').promise;
const config = require('./config');

const hostname = window.location.hostname;
const queryString = window.location.search;
const urlParams = new URLSearchParams(queryString);

let device;
let socket;
let myId;
let totalConsumers = 0;

const $ = document.querySelector.bind(document);
const $fsSubscribe = $('#fs_subscribe');
const $btnSubscribe = $('#btn_subscribe');
const $txtConnection = $('#connection_status');
const $txtSubscription = $('#sub_status');

const $audioOutputSelect = $('#audioOutput');

$btnSubscribe.addEventListener('click', subscribeClick);

// run "on-page-load" routines
connect();

// declarations
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
    console.log('connected');
    $fsSubscribe.disabled = false;

    const data = await socket.request('getRouterRtpCapabilities');
    await loadDevice(data);
  });

  socket.on('disconnect', () => {
    $txtConnection.innerHTML = 'Disconnected';
    $fsSubscribe.disabled = true;
    // TODO: cleanup here
  });

  socket.on('connect_error', (error) => {
    console.error('could not connect to %s%s (%s)', serverUrl, opts.path, error.message);
    $txtConnection.innerHTML = 'Connection failed';
    $btnConnect.disabled = false;
    // TODO: cleanup here
  });

  socket.on('admit', (d) => {
     const {name , id} = d;
     console.log('admitted', name, id);
     myId = id;
     $txtConnection.innerHTML = 'Connected as '+name+' (id '+id+')';

     if (urlParams.getAll('s').length)
       $txtSubscription.innerHTML = 'Setup to stream individual streams '+urlParams.getAll('s').join(' ');
     else
        $txtSubscription.innerHTML = 'Setup to stream from '+clientId;
  });

  socket.on('clientDisconnected', (id) => {
     console.log('client disconnected', id);
     // TODO: handle cleanup here
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

async function subscribeClick()
{
    subscribe(clientId, urlParams.getAll('s'));
}

async function subscribe(cId, sIds) {
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
        $txtSubscription.innerHTML = 'Subscribing...';
        $fsSubscribe.disabled = true;
        break;

      case 'connected':
        $txtSubscription.innerHTML = 'Streaming from';
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

  transport.observer.on('newconsumer', async (consumer) => {
      console.log('new consumer created ', consumer.id);
      $txtSubscription.innerHTML += `\n${consumer.id} (${consumer.kind})`;
  });

  const stream = makeMediaStream(transport, cId, sIds);

  // TODO: expand for multi-video
  // await stream;
  document.querySelector('#remote_video').srcObject = await stream;
  await socket.request('resume');
}

async function makeMediaStream(transport, cId, sIds) {
    let tracks = [];
    let sInfo;

    if (sIds && sIds.length)
    {
        sInfo = await socket.request('getStreamInfo', { streamIds: sIds });
    }
    else
    {
        let res = await socket.request('getClientStreams', { clientIds: [cId]});
        sInfo = res[cId];
    }

    for (var idx in sInfo)
    {
        let track = await consume(transport, sInfo[idx]);
        if (track)
            tracks.push(track);
    }

    const stream = new MediaStream();
    tracks.forEach(t => stream.addTrack(t));

    return stream;
}

async function consume(transport, sInfo) {

  const { rtpCapabilities } = device;
  const data = await socket.request('consume', { rtpCapabilities: rtpCapabilities, streamId: sInfo.id });

  if ('error' in data)
  {
      console.log('failed creating consumer: ', data.error);
      return null;
  }

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

  return consumer.track;
}
// TODO: implement selectable audio device output
/*
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
*/
