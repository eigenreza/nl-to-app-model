# Single image serving the API and the built client.
#
# Replay mode is the default, so a container started with no configuration
# answers from recorded traces and cannot reach a provider. Live generation
# needs DEMO_MODE=live and a key, both supplied at run time.

FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
RUN npm ci

COPY tsconfig.base.json tsconfig.json ./
COPY packages ./packages
RUN npm run build

# Reinstall without dev dependencies for the runtime layer.
RUN npm prune --omit=dev

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/packages/server/package.json ./packages/server/package.json
COPY --from=build /app/packages/server/dist ./packages/server/dist
COPY --from=build /app/packages/server/fixtures ./packages/server/fixtures
COPY --from=build /app/packages/web/dist ./packages/web/dist

USER node
EXPOSE 8787
ENV HOST=0.0.0.0 PORT=8787 DEMO_MODE=replay

CMD ["node", "packages/server/dist/main.js"]
