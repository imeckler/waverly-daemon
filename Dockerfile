FROM node:18-alpine

# Install necessary packages for USB device access and building native modules
RUN apk add --no-cache python3 make g++ eudev-dev linux-headers

WORKDIR /app

# Copy package files first for better layer caching
COPY package*.json ./
COPY tsconfig.json ./

# Install dependencies
RUN npm ci --only=production

# Copy source code
COPY src/ ./src/

# Build the application
RUN npm run build

# Create directory for Z-Wave cache
RUN mkdir -p ./zwave-cache

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs
RUN adduser -S appuser -u 1001

# Give the user access to the zwave-cache directory
RUN chown -R appuser:nodejs ./zwave-cache

USER appuser

# Start the application
CMD ["node", "build/index.js"]