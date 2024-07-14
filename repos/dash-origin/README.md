Dash Low-Latency Origin Server (Demo)

# Summary
Origin server to serve live ingests.

Receives all ingests and serves from disk or memory/cache.
All data served is send in HTTP/1.1 chunked encoding mode.

NOT SECURE, DO NOT USE FOR PRODUCTION. DO NOT LET THIS SERVER LEAVE YOUR VPN.
ALL MACHINES THIS SERVER TALKS TO HAVE TO BE TRUSTWORTHY. YOU HAVE BEEN WARNED.

# License
MIT license.

# Installation
## Requirements
### Origin Server (this software)
* node.js version >= 8
* node.js modules "bl" and "yargs"
* dash.js player version >= 2.9.3
	* Can be found here: https://github.com/Dash-Industry-Forum/dash.js
### Ingest Server
* FFmpeg newer or equal to commit e7c04eaf
	* Can be found here: https://git.ffmpeg.org/ffmpeg.git

## Setup
### Origin Server (this software)
* Clone the repository into a directory (refered as ${ROOT})
* Clone the dash.js repository into some directory (refered as ${DASHJS}) and build the debug version
* Choose/create a main data directory as the web root for the server (refered as ${DATAROOT}, e.g. ${ROOT}/data)
* Copy ${ROOT}/data/live.html into ${DATAROOT}
* Create a symlink to the dash.js player "dist" directory in ${DATAROOT} (${DATAROOT}/dist => ${DASHJS}/dist)
* Create an empty folder ${DATAROOT}/live for storing & serving ingested data
* Go to ${ROOT} and install the required modules via "npm install ${MODULE}"
	* See [Requirements] for the modules to install
	* This will create and populate a new directory in ${ROOT}/node_modules
* Start the origin server (node origin.js -h) to get a list of command line options and default values
* Run the origin server with the options you need

### Ingest Server
* Clone the FFmpeg repository and build
	* for libx264 support, install libx264 onto your system and run configure with

	  ./configure --enable-gpl --enable-libx264
* Once the server is up and running, start your ingest using FFmpeg
  See ${ROOT}/extras/gen_live_ingest.sh for a simple example to stream a local webcam
* Open a browser and browse to http://${SERVER}/live.html to receive the live stream
