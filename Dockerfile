FROM mcr.microsoft.com/playwright:v1.49.0-jammy

WORKDIR /app

COPY package*.json ./

# Install ALL dependencies (dev included) so tsc can run
RUN npm ci

# Compile TypeScript → produces dist/
RUN npm run build

# Now remove dev dependencies to keep image lean
RUN npm prune --omit=dev

COPY . .

EXPOSE 3000

CMD ["npm", "start"]