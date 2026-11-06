FROM node:22-alpine
RUN apk add --no-cache python3 tcpdump ca-certificates
COPY artifacts/devcore-universal-agent-template-v2.zip /tmp/kit.zip
RUN python3 -m zipfile -e /tmp/kit.zip /tmp/kit \
 && python3 /tmp/kit/devcore-universal-agent-template-v2/install.py --install-dir /opt/multicortex/devcore-universal-agent \
 && ln -s /usr/bin/python3 /usr/local/bin/llama-server
COPY tests/template-runtime/model_stub.py /opt/model_stub.py
ENV MULTICORTEX_CAPTURE_ENABLED=1 MULTICORTEX_DEVCORE_HOSTS=test.devcore.invalid
ENTRYPOINT ["/opt/multicortex/devcore-universal-agent/entrypoint-agent.sh"]
CMD ["llama-server", "/opt/model_stub.py", "--port", "7080", "--parallel", "6"]
