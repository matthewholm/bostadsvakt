# Bostadsvakten som container, för körning på home-vm (se README, "Köra på
# home-vm"). Byggs från repots rot: docker build -f drift/Dockerfile .
FROM node:24-bookworm-slim
LABEL app=bostadsvakt

# Webbläsaren delas av alla användare i avbilden, så att node-användaren når
# den som root installerade.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
# Bara Chromium behövs (maklarkalkyl.js), som i bostadsvakt.yml.
RUN npm ci --omit=dev \
 && npx playwright install --with-deps chromium \
 && rm -rf /var/lib/apt/lists/* /root/.npm

COPY src ./src
COPY drift ./drift

# uid 1000, samma som ägaren till /opt/bostadsvakt/data-repo på home-vm.
USER node
ENTRYPOINT ["bash", "drift/korning.sh"]
