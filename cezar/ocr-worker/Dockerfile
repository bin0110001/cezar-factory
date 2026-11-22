FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && npm install --global "@alibaba-group/open-code-review@1.14.1" \
 && useradd --system --uid 10001 --create-home ocr
WORKDIR /opt/ocr
COPY rules.json /opt/ocr/rules.json
COPY server.mjs /opt/ocr/server.mjs
RUN chown -R 10001:10001 /opt/ocr
USER 10001:10001
ENV PORT=8090 OCR_REPO_ROOT=/workspace OCR_RULE_PATH=/opt/ocr/rules.json OCR_NO_UPDATE=1
EXPOSE 8090
CMD ["node", "/opt/ocr/server.mjs"]
