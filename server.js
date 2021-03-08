const { v4: uuidv4 } = require('uuid');

const mediasoup = require('mediasoup');
const fs = require('fs');
const https = require('https');
const express = require('express');
const socketIO = require('socket.io');
const config = require('./config');

// Global variables
let worker;
let webServer;
let socketServer;
let expressApp;
let mediasoupRouter;

// stores all connected clients
var clientRoster = {};

// client class helper
class RtcClient {
    constructor(socket, name, id = null){
        this.clientId_ = id ? id : uuidv4();
        this.socket_ = socket;
        this.clientName_ = name;
        this.producerTransport_ = null;
        this.consumerTransport_ = null;

        this.producers_ = []
        this.consumers_ = []

        // setup communication protocol callbacks
        this.setupProtocol(this.socket_)
    }

    // sets up socket callbacks that define server-client
    // communication protocol
    setupProtocol(socket)
    {
        socket.on('disconnect', () => {
          console.log('DISCONNECT', this.clientName_, this.clientId_);
          socket.broadcast.emit('clientDisconnected', this.clientId_);
          this.cleanup();
        });

        socket.on('connect_error', (err) => {
          console.error('client connection error', err);
          cleanup();
        });

        socket.on('getRouterRtpCapabilities', (data, callback) => {
          callback(mediasoupRouter.rtpCapabilities);
        });

        socket.on('getClientStreams', (data, callback) => {
            const { clientIds } = data;
            let streams = {};

            clientIds.forEach(function(cId) {
                if (cId in clientRoster)
                    streams[cId] = clientRoster[cId].producers_.map(p => ({id: p.id, kind: p.kind}));
            });

            callback(streams);
        });

        socket.on('getStreamInfo', (data, callback) => {
            const { streamIds } = data;
            let streams = [];

            for (var cId in clientRoster)
            {
                let c = clientRoster[cId];
                c.producers_.forEach(function(p){
                    if (streamIds.includes(p.id))
                        streams.push({ id:p.id, kind: p.kind, client: cId });
                });
            }

            callback(streams);
        });

        socket.on('createProducerTransport', async (data, callback) => {
          try {
            const { transport, params } = await createWebRtcTransport();
            this.producerTransport_ = transport;
            this.producers_ = [];
            callback(params);
          } catch (err) {
            console.error(err);
            callback({ error: err.message });
          }
        });

        socket.on('createConsumerTransport', async (data, callback) => {
          try {
            const { transport, params } = await createWebRtcTransport();
            this.consumerTransport_ = transport;
            this.consumers_ = [];
            callback(params);
          } catch (err) {
            console.error(err);
            callback({ error: err.message });
          }
        });

        socket.on('connectProducerTransport', async (data, callback) => {
          await this.producerTransport_.connect({ dtlsParameters: data.dtlsParameters });
          callback();
        });

        socket.on('connectConsumerTransport', async (data, callback) => {
          await this.consumerTransport_.connect({ dtlsParameters: data.dtlsParameters });
          callback();
        });

        socket.on('produce', async (data, callback) => {
          const {kind, rtpParameters} = data;
          const producer = await this.producerTransport_.produce({kind, rtpParameters});
          callback({id: producer.id});

          this.producers_.push(producer);
          // inform clients about new producer
          this.socket_.broadcast.emit('newProducer', { clientId: this.clientId_, producerId: producer.id } );
          console.log('new producer', producer.kind, producer.id, this.clientName_, this.clientId_);

          producer.on("transportclose", () =>
          {
            console.log("transport closed so producer closed");
            this.producers_.splice(this.producers_.indexOf(producer));
          });

          producer.observer.on('close', () => {
              console.log('producer close', producer.id);
              this.producers_.splice(this.producers_.indexOf(producer));
          });
        });

        socket.on('consume', async (data, callback) => {
          let producer = getProducer(data.streamId);
          if (producer)
            callback(await this.createConsumer(producer, data.rtpCapabilities));
          else
          {
              console.log('failed to find producer', data.streamId);
              callback({ error: `producer ${data.streamId} not found`});
          }
        });

        socket.on('resume', async (data, callback) => {
          const { consumerId } = data;
          if (consumerId)
          {
              let c = getConsumer(consumerId);
              if (c)
              {
                  console.log('resume', consumerId);
                  await c.resume();
              }
              else
                console.log(`consumer ${consumerId} not found`);
          }
          else
          {
              this.consumers_.forEach(async c => await c.resume());
              console.log(`resumed ${this.consumers_.length} consumers for ${this.clientId_}`);
          }

          callback();
        });
    }

    // TODO: shut down all mediasoup objects properly
    cleanup() {
        if (this.clientId_ in clientRoster)
            delete clientRoster[this.clientId_];
    }

    async createConsumer(producer, rtpCapabilities) {
      if (!mediasoupRouter.canConsume(
        {
          producerId: producer.id,
          rtpCapabilities,
        })
      ) {
        console.error('can not consume');
        return;
      }

      let consumer;

      try {
        consumer = await this.consumerTransport_.consume({
          producerId: producer.id,
          rtpCapabilities,
          paused: true,
        });
      } catch (error) {
        console.error('consume failed', error);
        return;
      }

      if (consumer.type === 'simulcast') {
        console.log('set simulcast consumer');
        await consumer.setPreferredLayers({ spatialLayer: 2, temporalLayer: 2 });
      }

      this.consumers_.push(consumer);
      console.log(`add consumer ${consumer.id} for ${this.clientId_}. total ${this.consumers_.length}`);

      return {
        producerId: producer.id,
        id: consumer.id,
        kind: consumer.kind,
        rtpParameters: consumer.rtpParameters,
        type: consumer.type,
        producerPaused: consumer.producerPaused
      };
    }

    static generateName()
    {
        var firstname = ["Edgar", "Naruto", "Luffy", "Billigan", "Hip"];
	    var lastname= ["Slow Poke", "Uzumaki", "Squiggles", "Romanof", "Phantom"];
	    var rand_first = Math.floor(Math.random()*firstname.length);
	    var rand_last = Math.floor(Math.random()*lastname.length);

	    return lastname[rand_last] + ' ' + firstname[rand_first];
    }
}


(async () => {
  try {
    await runExpressApp();
    await runWebServer();
    await runSocketServer();
    await runMediasoupWorker();
  } catch (err) {
    console.error(err);
  }
})();

async function runExpressApp() {
  expressApp = express();
  expressApp.set('views', './views');
  expressApp.engine('html', require('ejs').renderFile);
  expressApp.set('view engine', 'html');
  expressApp.use(express.json());
  expressApp.use(express.static(__dirname));
  expressApp.use(express.static(__dirname+'/views'));

  expressApp.use((error, req, res, next) => {
    if (error) {
      console.warn('Express app error,', error.message);

      error.status = error.status || (error.name === 'TypeError' ? 400 : 500);

      res.statusMessage = error.message;
      res.status(error.status).send(String(error));
    } else {
      next();
    }
  });
  expressApp.get('/list', function (req, res){
      let list = [];
      for (var k in clientRoster)
      {
          const c = clientRoster[k];
          list.push({
              'id': c.clientId_,
              'name': c.clientName_,
              'consumeUrl': makeClientConsumeUrl(c),
              'producers': [c.producers_.map(p => ({
                  id: p.id,
                  type: p.kind,
                  consumeUrl: makeClientConsumeUrl(c, [p.id])})
              )]
          });
      }
      res.send(list);
  });
  expressApp.get('/produce', function (req, res) {
      console.log('serving producer');
      res.render('produce.html');
  });
  expressApp.get('/consume/:clientId', function (req, res) {
     console.log('consuming streams from', req.params.clientId);
     res.render('consume.html', req.params);
  });
}

function makeClientConsumeUrl(c, streams) {
    const { listenIp, listenPort } = config;
    if (streams)
        return `https://${listenIp}:${listenPort}/consume/${c.clientId_}/?s=${streams.join('&s=')}`;
    else
        return `https://${listenIp}:${listenPort}/consume/${c.clientId_}`;
}

async function runWebServer() {
  const { sslKey, sslCrt } = config;
  if (!fs.existsSync(sslKey) || !fs.existsSync(sslCrt)) {
    console.error('SSL files are not found. check your config.js file');
    process.exit(0);
  }
  const tls = {
    cert: fs.readFileSync(sslCrt),
    key: fs.readFileSync(sslKey),
  };
  webServer = https.createServer(tls, expressApp);
  webServer.on('error', (err) => {
    console.error('starting web server failed:', err.message);
  });

  await new Promise((resolve) => {
    const { listenIp, listenPort } = config;
    webServer.listen(listenPort, listenIp, () => {
      const listenIps = config.mediasoup.webRtcTransport.listenIps[0];
      const ip = listenIps.announcedIp || listenIps.ip;
      console.log('server is running');
      console.log(`open https://${ip}:${listenPort} in your web browser`);
      resolve();
    });
  });
}

async function runSocketServer() {
  socketServer = socketIO(webServer, {
    serveClient: false,
    path: '/server',
    log: false,
  });

  socketServer.on('connection', (socket) => {
    var clientName = socket.handshake.query.name;
    var id = socket.handshake.query.id;

    if (!clientName)
        clientName = RtcClient.generateName();

    var client = new RtcClient(socket, clientName, id);
    clientRoster[client.clientId_] = client;

    console.log('CONNECTED', clientName, client.clientId_);

    socket.emit('admit', { name: client.clientName_, id: client.clientId_ });
    socket.broadcast.emit('newClient', { name: client.clientName_, id: client.clientId_ });
  });
}

async function runMediasoupWorker() {
  worker = await mediasoup.createWorker({
    logLevel: config.mediasoup.worker.logLevel,
    logTags: config.mediasoup.worker.logTags,
    rtcMinPort: config.mediasoup.worker.rtcMinPort,
    rtcMaxPort: config.mediasoup.worker.rtcMaxPort,
  });

  worker.on('died', () => {
    console.error('mediasoup worker died, exiting in 2 seconds... [pid:%d]', worker.pid);
    setTimeout(() => process.exit(1), 2000);
  });

  const mediaCodecs = config.mediasoup.router.mediaCodecs;
  mediasoupRouter = await worker.createRouter({ mediaCodecs });
}

async function createWebRtcTransport() {
  const {
    maxIncomingBitrate,
    initialAvailableOutgoingBitrate
  } = config.mediasoup.webRtcTransport;

  const transport = await mediasoupRouter.createWebRtcTransport({
    listenIps: config.mediasoup.webRtcTransport.listenIps,
    enableUdp: true,
    enableTcp: true,
    preferUdp: true,
    initialAvailableOutgoingBitrate,
  });
  if (maxIncomingBitrate) {
    try {
      await transport.setMaxIncomingBitrate(maxIncomingBitrate);
    } catch (error) {
    }
  }
  return {
    transport,
    params: {
      id: transport.id,
      iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters
    },
  };
}

function getProducer(streamId) {
    for (var cId in clientRoster)
    {
        let producer = clientRoster[cId].producers_.find(p => p.id === streamId);
        if (producer)
            return producer;
    }

    return null;
}

function getConsumer(streamId) {
    for (var cId in clientRoster)
    {
        let consumer = clientRoster[cId].consumers_.find(c => c.id === streamId);
        if (consumer)
            return consumer;
    }

    return null;
}
