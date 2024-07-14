FROM node:21

WORKDIR /app

# Copy the current directory contents into the container at /app
COPY . .

# Create the live output directory
RUN mkdir -p /app/data/live

# Install any needed packages specified in package.json
RUN npm install

# Run the server when the container launches
CMD ["node", "origin.js", "--data", "/app/data", "--verbose"]