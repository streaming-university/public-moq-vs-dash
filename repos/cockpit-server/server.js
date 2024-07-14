const https = require("https");
const fs = require("fs");
// http version
// const WebSocket = require("ws");
const { WebSocketServer } = require("ws");
const { join } = require("path");
const { exec } = require("child_process");

const BASH_PATH = "/bin/bash";

const httpsServer = https.createServer({
  cert: fs.readFileSync("cert/cert.pem"),
  key: fs.readFileSync("cert/key.pem"),
});

// http version
// const wss = new WebSocket.Server({ port: 8000 });

const currentBandwidthLimits = {
  dash: [],
  moq: [],
};

const wss = new WebSocketServer({ server: httpsServer });

wss.on("connection", function connection(ws, req) {
  ws.on("message", function incoming(rawMessage) {
    try {
      // Convert message to string if it's not already
      const message = rawMessage.toString();

      let client_ip;
      if (!req.headers["x-forwarded-for"]) {
        // there is no reverse proxy
        client_ip = req.socket.remoteAddress;
      } else {
        client_ip = req.headers["x-forwarded-for"].split(/\s*,\s*/)[0];
      }
      // fix for ipv6
      // In order to run iptables scripts correctly, we need to remove the ipv6 prefix
      // more info: https://stackoverflow.com/a/33790357/195124 (Express.js req.ip is returning ::ffff:127.0.0.1)
      if (client_ip.startsWith('::ffff:')) {     
        client_ip = client_ip.substring(7)   
      }

      console.log("received:", message);
      console.log("from:", client_ip);
      const [command, serverType, rate] = message.split(" ");
      ws.send(`Command: ${command}, Server Type: ${serverType}, Rate: ${rate}`);

      if (command === "set" && serverType && rate) {
        handleBandwidthLimit(serverType, rate, ws, client_ip);
        currentBandwidthLimits[serverType].push({
          limit: rate,
          updatedAt: new Date().toLocaleTimeString(),
        });
      } else if (command === "clear" && serverType) {
        ws.send(`Clearing bandwidth limit on ${serverType}`);
        clearBandwidthLimit(serverType, ws, client_ip);
        currentBandwidthLimits[serverType].push({
          limit: Math.max,
          updatedAt: new Date().toLocaleTimeString(),
        });
      } else if (command === "get" && serverType) {
        // server type can be "all"
        ws.send(JSON.stringify(getBandwidthLimits(serverType)));
      } else {
        ws.send("Error: Invalid message format.");
      }
    } catch (error) {
      console.error("Error handling message:", error);
      ws.send(`Error: ${error.message}`);
    }
  });

  ws.send("Connected to Cockpit server");
});

function handleBandwidthLimit(serverType, rate, ws, client_ip) {
  // serverType is either "dash" or "moq"
  const scriptPath = join(__dirname, "tc", "set_bandwidth.sh");
  const command = `${BASH_PATH} ${scriptPath} ${serverType} ${rate} ${client_ip}`;

  exec(command, (error, stdout, stderr) => {
    if (error) {
      console.error(`Error executing script: ${error.message}`);
      ws.send(`Error: ${error.message}`);
      return;
    }
    if (stderr) {
      console.error(`Stderr from script: ${stderr}`);
      ws.send(`Error: ${stderr}`);
      return;
    }

    console.log(`Stdout from script: ${stdout}`);
    ws.send(`Bandwidth set to ${rate}Mbps on ${serverType}`);
  });
}

function clearBandwidthLimit(serverType, ws, client_ip) {
  const scriptPath = join(__dirname, "tc", "set_bandwidth.sh");
  const command = `${BASH_PATH} ${scriptPath} ${serverType} 0 ${client_ip} del`;

  exec(command, (error, stdout, stderr) => {
    if (error) {
      console.error(`Error executing script: ${error.message}`);
      ws.send(`Error: ${error.message}`);
      return;
    }
    if (stderr) {
      console.error(`Stderr from script: ${stderr}`);
      ws.send(`Error: ${stderr}`);
      return;
    }
    console.log(`Stdout from script: ${stdout}`);
    ws.send(`Bandwidth cleared on ${serverType}`);
  });
}

function getBandwidthLimits(serverType) {
  if (serverType === "all") {
    return currentBandwidthLimits;
  } else {
    return currentBandwidthLimits[serverType] || [];
  }
}

const port = process.env.PORT || 8000;
httpsServer.listen(port, function () {
  console.log(`Cockpit WebSocket server listening on ${port}`);
});
