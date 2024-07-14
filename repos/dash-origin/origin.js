/*
MIT License

Copyright (c) 2019 Thilo Borgmann < thilo _at_ fflabs.eu >

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/

// NOT SECURE, DO NOT USE FOR PRODUCTION. DO NOT LET THIS SERVER LEAVE YOUR VPN.
// ALL MACHINES THIS SERVER TALKS TO HAVE TO BE TRUSTWORTHY. YOU HAVE BEEN WARNED.

// Simple relay server for ingested streams to be served to clients
// with low latency and HTTP/1.1 chunked encoding

/// required modules
const BufferList = require("bl"); // dependency usually to be installed via npm
const yargs = require("yargs"); // dependency usually to be installed via npm
const EventEmitter = require("events");
const fs = require("fs");
const http = require("http");
const https = require("https");
const util = require("util");

/// globals
var data_root; /// root directory for all data
var server_port_ingest; /// server listening port for ingest
var server_port_delivery; /// server listening port for delivery
var server_proto; /// set to serve HTTP or HTTPS connections
const stream_cache = new Map(); /// global data cache for incoming ingests

/// command line options
const options = yargs
  .usage("Usage: $0 [options]")
  .option("clear_data", {
    description: "Clears <data_root> during startup",
    type: "boolean",
    default: false,
  })
  .option("delete_chunks_timeout", {
    description:
      "Deletes old chunks after n seconds, any value below 10 keeps chunks forever",
    type: "number",
    default: 60,
  })
  .option("data", {
    description: "Set <data_root> directory for the server",
    type: "string",
    default: "./data",
    alias: "d",
  })
  .option("port_in", {
    description: "Set the server to listen for ingest on the given port",
    type: "number",
    default: 8079,
  })
  .option("port_out", {
    description: "Set the server to listen for delivery on the given port",
    type: "number",
    default: 8080,
  })
  .option("key", {
    description: "Server-side private key",
    type: "string",
    default: "",
    alias: "k",
  })
  .option("cert", {
    description: "Server-side certificate",
    type: "string",
    default: "",
    alias: "c",
  })
  .option("ca", {
    description: "Server-side CA certificate",
    type: "string",
    default: "",
  })
  .option("verbose", {
    description: "More logging",
    type: "boolean",
    default: false,
    alias: "v",
  })
  .version("version", "Shows the server version", "1.0")
  .help().argv;

/// process command line options
function parse_cmd() {
  // set given or default values
  if (options.data) {
    data_root = options.data;
  }

  if (options.port_in) {
    server_port_ingest = options.port_in;
  }
  if (options.port_out) {
    server_port_delivery = options.port_out;
  }

  // choose connection type based on required options
  if (options.key && options.cert && options.ca) {
    server_proto = "https";
  } else {
    server_proto = "http";
  }

  // clear data if wanted
  if (options.clear_data) {
    unlink_data_ingest();
  }

  if (options.verbose) {
    console.log("Finished parsing cmd line:");
    console.log(`data_root:            ${data_root}`);
    console.log(`server_port_ingest:   ${server_port_ingest}`);
    console.log(`server_port_delivery: ${server_port_delivery}`);
    console.log(`server_proto:         ${server_proto}`);
  }
}

/// data object for caching ingest data
/// Writes all incoming data to storage and keeps
/// a copy in memory for live serving until the
/// file is completely received and written.
class CacheElem extends EventEmitter {
  constructor() {
    super();
    this.buffer_list = new BufferList();
    this.res = [];
    this.ended = false;
  }
}

/// checks GET or POST request URLs for sanity to avoid spammers & crashes
function check_sanity(url) {
  var begin = url.substr(0, 5);
  return begin == "/live" || begin == "/dist" || begin == "/dash";
}

/// unlinks all files in data_ingest directory
/// Called during startup before the server starts listening.
function unlink_data_ingest() {
  const data_ingest = data_root + "/live";
  console.log(`Unlinking all ingest data at: ${data_ingest}`);
  files = fs.readdirSync(data_ingest);

  for (var i = 0; i < files.length; i++) {
    fs.unlinkSync(data_ingest + "/" + files[i]);
  }
}

/// sends the no such file response (http 404)
function send_404(res) {
  res.statusCode = 404;
  res.statusMessage = "Not found";
  res.end();
}

/// sends the internal server error response (http 500)
function send_500(res) {
  res.statusCode = 500;
  res.statusMessage = "Internal error";
  res.end();
}

/// sends a complete file of known length from storage as a single response
/// @param  res             HttpResponse to write the data into
/// @param  content_type    String to write for the content type of the response
/// @param  filename        The file containing the data to be send
function send_fixed_length(res, content_type, filename) {
  fs.readFile(filename, (err, data) => {
    if (err) {
      send_404(res);
      throw err;
    } else {
      res.writeHead(200, {
        "Content-Length": Buffer.byteLength(data),
        "Content-Type": content_type,
        "Access-Control-Allow-Origin": "*",
      });
      res.write(data);
      res.end();
    }
  });
}

/// sends a complete file from storage as a chunked response
/// @param  res             HttpResponse to write the data into
/// @param  content_type    String to write for the content type of the response
/// @param  filename        The file containing the data to be send
function send_chunked(res, content_type, filename) {
  var stream = fs.createReadStream(filename);

  stream.on("error", (err) => {
    console.log(`404 bad file ${filename}`);

    send_404(res);
  });

  stream.once("readable", () => {
    // implicitly set to chunked encoding if pipe'd to res, needs to be set for res.write()
    // also set content-type correctly (even if pipe'd)
    res.writeHead(200, {
      "Content-Type": content_type,
      "Transfer-Encoding": "chunked",
      "Access-Control-Allow-Origin": "*",
    });
    stream.pipe(res);
  });
}

/// sends a complete file from cache (if found) or storage (fallback) as a chunked response
/// @param  res             HttpResponse to write the data into
/// @param  content_type    String to write for the content type of the response
/// @param  filename        The file containing the data to be send
function send_chunked_cached(res, content_type, filename) {
  if (stream_cache.has(filename)) {
    const cache_elem = stream_cache.get(filename);

    res.writeHead(200, {
      "Content-Type": content_type,
      "Transfer-Encoding": "chunked",
      "Access-Control-Allow-Origin": "*",
    });

    const current = cache_elem.buffer_list.slice();
    res.write(current);

    if (cache_elem.ended) {
      res.end();
    } else {
      cache_elem.res.push(res);
      cache_elem.on("data", function (chunk) {
        //console.log(`data event for ${filename}`);
        res.write(chunk);
      });
    }
  } else {
    send_chunked(res, content_type, filename);
  }
}

function set_cors_headers(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, OPTIONS, PUT, DELETE"
  );
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Access-Control-Allow-Headers, Authorization, X-Requested-With"
  );
}

/// create server and define handling of supported requests
function request_listener(req, res) {
  set_cors_headers(res);

  if (req.method == "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  if (!check_sanity(req.url)) {
    if (options.verbose) {
      console.log(`ReJECT ${req.method} ${req.url}`);
    }
  } else if (req.method == "GET") {
    const suffix_idx = req.url.lastIndexOf(".");
    const suffix = req.url.slice(suffix_idx, req.url.length);
    var filename = data_root + req.url;

    if (options.verbose) {
      console.log(`GET ${req.url}`);
    }

    switch (suffix) {
      case ".html":
        send_chunked(res, "text/html", filename);
        break;
      case ".js":
        send_chunked(res, "application/javascript", filename);
        break;
      case ".mpd":
        send_chunked(res, "application/dash+xml", filename);
        break;
      case ".m4s":
        send_chunked_cached(res, "video/iso.segment", filename);
        break;
      default:
        console.log(`404 bad suffix ${suffix}`);
        send_404(res);
        break;
    }
  } else if (req.method == "POST") {
    // check for POST method, ignore others
    const suffix_idx = req.url.lastIndexOf(".");
    const suffix = req.url.slice(suffix_idx, req.url.length);
    const filename = data_root + req.url;

    if (options.verbose) {
      console.log(`POST ${req.url}`);
    }

    const file_stream = fs.createWriteStream(filename);
    const file_cache = new CacheElem();

    file_stream.on("error", (err) => {
      send_500(res);
      throw err;
    });

    stream_cache.set(filename, file_cache);

    stream_cache.get(filename).on("end", function () {
      this.ended = true;
      const l = this.res.length;
      for (var i = 0; i < l; i++) {
        this.res[0].end(); // end transmission on first response
        this.res.shift(); // delete response from array
      }
      stream_cache.delete(filename);
    });

    req.on("data", (chunk) => {
      stream_cache.get(filename).buffer_list.append(chunk);
      stream_cache.get(filename).emit("data", chunk);
      file_stream.write(chunk);
    });
    //req.on('close', () => { // not every stream emits 'close', so rely on 'end' event
    //});
    req.on("end", () => {
      stream_cache.get(filename).emit("end");
      file_stream.end();

      // set timer to delete old segment files on disk after timeout
      // only apply if options.delete_chunks_timeout has a sane value of more or equal to 10s
      // only apply to files with "chunk-" in it
      if (options.delete_chunks_timeout >= 10 && req.url.includes("chunk-")) {
        const unlink_timer = util.promisify(setTimeout);
        unlink_timer(options.delete_chunks_timeout * 1000, filename).then(
          (fname) => {
            fs.unlinkSync(fname);
          }
        );
      }
    });
  } else if (req.method == "DELETE") {
    // check for DELETE method
    const suffix_idx = req.url.lastIndexOf(".");
    const suffix = req.url.slice(suffix_idx, req.url.length);
    const filename = data_root + req.url;

    if (options.verbose) {
      console.log(`DELETE ${req.url}`);
    }

    fs.unlink(filename, (err) => {
      if (err) throw err;
    });
  } else {
    if (options.verbose) {
      console.log(`Unhandled request method ${req.method}.`);
    }
  }
}

// parse cmd line
parse_cmd();

// create the servers
var server_ingest;
var server_delivery;

if (server_proto == "https") {
  try {
    var https_options = {
      key: fs.readFileSync(options.key),
      cert: fs.readFileSync(options.cert),
      ca: fs.readFileSync(options.ca),
      requestCert: false,
      rejectUnauthorized: false,
    };
    server_ingest = https.createServer(https_options, request_listener);
  } catch (err) {
    console.error(
      `Error reading private key or certificate or CA certificate file!`,
      err
    );
    process.exit(1);
  }
} else {
  server_ingest = http.createServer(request_listener);
}

server_delivery = http.createServer(request_listener);

// start the servers
server_ingest.listen(server_port_ingest);
server_delivery.listen(server_port_delivery);

// ready to receive ingests and client requests
console.log(`Listening for ingest on port:   ${server_port_ingest}`);
console.log(`Listening for delivery on port: ${server_port_delivery}`);
