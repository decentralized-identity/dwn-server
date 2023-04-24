import { WebSocket } from 'ws';

import { v4 as uuidv4 } from 'uuid';
import { WebSocketServer } from 'ws';

import { rpcRouter } from './rpc-router.js';
import { createJsonRpcErrorResponse, JsonRpcErrorCodes, JsonRpcResponse } from './lib/json-rpc.js';

export const wsServer = new WebSocketServer({ noServer: true });

wsServer.on('connection', function(socket: WebSocket, _request, _client) {
  socket['id'] = uuidv4();
  socket['isAlive'] = true;

  // Pong messages are automatically sent in response to ping messages as required by
  // the websocket spec. So, no need to send explicit pongs from browser
  socket.on('pong', function() {
    this['isAlive'] = true;
  });

  socket.on('message', async function(dataBuffer) {
    let dwnRequest;

    try {
      // deserialize bytes into JSON object
      dwnRequest = dataBuffer.toString();
      if (!dwnRequest) {
        const jsonRpcResponse = createJsonRpcErrorResponse(uuidv4(),
          JsonRpcErrorCodes.BadRequest, 'request payload required.');

        const responseBuffer = jsonRpcResponseToBuffer(jsonRpcResponse);
        return socket.send(responseBuffer);
      }

      dwnRequest = JSON.parse(dwnRequest);
    } catch(e) {
      const jsonRpcResponse = createJsonRpcErrorResponse(
        uuidv4(), JsonRpcErrorCodes.BadRequest, e.message);

      const responseBuffer = jsonRpcResponseToBuffer(jsonRpcResponse);
      return socket.send(responseBuffer);
    }

    const { jsonRpcResponse } = await rpcRouter.handle(dwnRequest, { transport: 'ws' });

    const responseBuffer = jsonRpcResponseToBuffer(jsonRpcResponse);
    return socket.send(responseBuffer);
  });
});

// Sometimes connections between client <-> server can get borked in such a way that
// leaves both unaware of the borkage. ping messages can be used as a means to verify
// that the remote endpoint is still responsive. Server will ping each socket every 30s
// if a pong hasn't received from a socket by the next ping, the server will terminate
// the socket connection
const heartbeatInterval = setInterval(function () {
  wsServer.clients.forEach(function (socket) {
    if (socket['isAlive'] === false) {
      return socket.terminate();
    }

    socket['isAlive'] = false;
    socket.ping();
  });
}, 30_000);

function jsonRpcResponseToBuffer(jsonRpcResponse: JsonRpcResponse) {
  const str = JSON.stringify(jsonRpcResponse);
  return Buffer.from(str);
}

wsServer.on('close', function close() {
  clearInterval(heartbeatInterval);
});