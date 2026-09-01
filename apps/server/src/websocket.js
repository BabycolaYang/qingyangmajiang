import { createHash, randomUUID } from "node:crypto";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export function acceptWebSocketUpgrade(request, socket) {
  const key = request.headers["sec-websocket-key"];
  if (!key) {
    socket.destroy();
    return null;
  }

  const acceptKey = createHash("sha1").update(`${key}${GUID}`).digest("base64");
  socket.write(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${acceptKey}`,
      "",
      "",
    ].join("\r\n"),
  );

  const peer = {
    id: randomUUID(),
    socket,
    buffer: Buffer.alloc(0),
    send(payload) {
      if (socket.destroyed) {
        return;
      }
      socket.write(encodeFrame(JSON.stringify(payload)));
    },
    close() {
      if (!socket.destroyed) {
        socket.end();
      }
    },
  };

  return peer;
}

export function readFrames(peer, chunk, onMessage) {
  peer.buffer = Buffer.concat([peer.buffer, chunk]);

  while (peer.buffer.length >= 2) {
    const frame = decodeFrame(peer.buffer);
    if (!frame) {
      return;
    }
    peer.buffer = peer.buffer.subarray(frame.bytesRead);

    if (frame.opcode === 8) {
      peer.close();
      return;
    }
    if (frame.opcode === 9) {
      peer.socket.write(encodeFrame(frame.payload, 10));
      continue;
    }
    if (frame.opcode !== 1) {
      continue;
    }

    const text = frame.payload.toString("utf8");
    onMessage(JSON.parse(text));
  }
}

function encodeFrame(payload, opcode = 1) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload));
  const length = data.length;
  let header;

  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }

  return Buffer.concat([header, data]);
}

function decodeFrame(buffer) {
  if (buffer.length < 2) {
    return null;
  }

  const firstByte = buffer[0];
  const secondByte = buffer[1];
  const opcode = firstByte & 0x0f;
  const masked = Boolean(secondByte & 0x80);
  let length = secondByte & 0x7f;
  let offset = 2;

  if (length === 126) {
    if (buffer.length < offset + 2) {
      return null;
    }
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    if (buffer.length < offset + 8) {
      return null;
    }
    length = Number(buffer.readBigUInt64BE(offset));
    offset += 8;
  }

  let mask;
  if (masked) {
    if (buffer.length < offset + 4) {
      return null;
    }
    mask = buffer.subarray(offset, offset + 4);
    offset += 4;
  }

  if (buffer.length < offset + length) {
    return null;
  }

  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (masked) {
    for (let index = 0; index < payload.length; index += 1) {
      payload[index] ^= mask[index % 4];
    }
  }

  return {
    opcode,
    payload,
    bytesRead: offset + length,
  };
}

