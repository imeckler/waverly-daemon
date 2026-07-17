# syntax=docker/dockerfile:1
FROM node:18-alpine

# Install necessary packages for USB device access and building native modules.
# git + openssh-client are needed to fetch the private @waverly/sauna-protocol
# git dependency during `npm ci`.
RUN apk add --no-cache python3 make g++ eudev-dev linux-headers git openssh-client

WORKDIR /app

# Copy package files first for better layer caching
COPY package*.json ./
COPY tsconfig.json ./

# Install ALL dependencies (devDeps needed for the build, e.g. typescript and @types/*).
# The read-only deploy key for the private @waverly/sauna-protocol repo is passed
# as a build secret (never baked into a layer). See docker-compose build.secrets.
RUN --mount=type=secret,id=sauna_deploy_key \
    mkdir -p -m 0700 ~/.ssh \
    && ssh-keyscan -t ed25519 github.com >> ~/.ssh/known_hosts 2>/dev/null \
    && GIT_SSH_COMMAND="ssh -i /run/secrets/sauna_deploy_key -o IdentitiesOnly=yes" npm ci

# Copy source code
COPY src/ ./src/

# Copy configuration file
COPY config.json ./

# Build the application
RUN npm run build

# Strip devDeps from the final image — they were only needed for the build above.
RUN npm prune --omit=dev

# Create directory for Z-Wave cache
RUN mkdir -p ./zwave-cache

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs
RUN adduser -S appuser -u 1001
# Add user to dialout group for serial port access
RUN adduser appuser dialout

# Give the user access to the zwave-cache directory
RUN chown -R appuser:nodejs ./zwave-cache

USER appuser

# Start the application
CMD ["node", "build/index.js"]