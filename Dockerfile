# Static site: any web server works. This image serves it with Node.
FROM node:22-alpine
WORKDIR /app
COPY . .
ENV PORT=10000
EXPOSE 10000
CMD ["node", "tools/serve.mjs"]
