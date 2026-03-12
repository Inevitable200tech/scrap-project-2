# Official Playwright image — updated to 1.57.0
FROM mcr.microsoft.com/playwright:v1.57.0-jammy

ENV NODE_ENV=production
# Disable the bloated "WEB_CONCURRENCY" logic from Render to save RAM
ENV WEB_CONCURRENCY=1

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install only what is needed.
# We use 'npm install' instead of 'ci' here to ensure local binaries are built.
RUN npm install --production=false

# Install ONLY the chromium browser (Saves GBs of disk and MBs of RAM)
RUN npx playwright install chromium

# Copy the rest of the code
COPY . .

# Expose your port
EXPOSE 823

# Start using the absolute path to tsx to avoid npx overhead
# Status 128 often happens if 'npx' fails to find the binary
CMD ["./node_modules/.bin/tsx", "main.ts"]