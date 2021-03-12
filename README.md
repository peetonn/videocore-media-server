# VideoCore Media Server

An [SFU](https://webrtcglossary.com/sfu/) media server + minimalist Web client app based on [Mediasoup](https://mediasoup.org/) and Socket.io.
Allows connecting clients to produce and consume WebRTC media streams.
Implements media server protocol for [VideoCore (RTC) plugin](https://github.com/remap/VideoCore).

## Dependencies

* [Mediasoup v3 requirements](https://mediasoup.org/documentation/v3/mediasoup/installation/#requirements)
* Node.js >= v8.6
* [Browserify](http://browserify.org/)


## Run

The server app runs on any supported platform by Mediasoup. The client app runs on a single browser tab.
```
# create and modify the configuration
# make sure you set the proper IP for mediasoup.webRtcTransport.listenIps
cp config.example.js config.js
nano config.js

# install dependencies and build mediasoup
npm install

# create the client bundle and start the server app
npm start
```

# Web Interface

This media server includes a simplistic client web interface for producing and consuming audio and video streams, as well for inspecting the state of the server.

## Produce

The "produce" web interface allows to select your capture devices and start producing media from them, available for fetching.
Opening "produce" webpage automatically connects your client to the media server, i.e. if not specified, your client will receive a unique name and ID.
The ID is required for accessing produced media by other remote clients (see "Consume" below).

* Produce URL format:

```
https://<server_url>:3000/produce[/?name=<optional_client_name>][&id=<optional_client_id>]
```

## Consume

The "consume" UI requires you to specify ID of a client you want to consume media streams from.
By default, it'll try to fetch first video srteam and first audio stream provided by the client (in case client have more than one of each kind).
It is also possible to consume specific streams by specifying however many stream IDs as parameters.

* Consume URL format:

```
https://<server_url>:3000/consume/<client_id>[/?s=<optional_stream_id1>]...[&s=<optional_stream_idN>]
```

## List (API endpoint)

Reply is a JSON array containing informationn about currently connected clients, such as client name, client id, consumer and producer instances.

* Endpoint:

```
https://<server_url>:3000/list
```
