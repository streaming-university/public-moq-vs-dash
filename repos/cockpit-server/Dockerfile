FROM node:21

WORKDIR /app

# Install iptables and iproute2
RUN apt-get update && \
    apt-get install -y --no-install-recommends iptables iproute2 bc && \
    rm -rf /var/lib/apt/lists/*

COPY package.json .

RUN npm install

COPY . .

# Run the server when the container launches
CMD ["node", "server.js", "--verbose"]
