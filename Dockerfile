# Official Playwright image — updated to 1.57.0
FROM mcr.microsoft.com/playwright:v1.57.0-jammy

# Set environment to production
ENV NODE_ENV=production

WORKDIR /app

# Copy package files
COPY package*.json ./

# 1. Install EVERYTHING (including tsx) so it's BAKED into the image
# This prevents downloading things at runtime
RUN npm install

# 2. Install Playwright browsers (Chromium only to save space/RAM)
RUN npx playwright install chromium

# Copy source code
COPY . .

# Expose your specific port
EXPOSE 823

# 3. Execute directly from local node_modules. 
# We avoid npx to save the memory overhead of the npm registry check.
CMD ["./node_modules/.bin/tsx", "--expose-gc", "main.ts"]