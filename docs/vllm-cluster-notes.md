# vLLM deployment notes

The first deployment is a single vLLM service on the Mac mini. The Bazzite
server consumes it through LiteLLM and does not host model weights.

The deployment contract keeps these values external:

- model identifier and served model name;
- Hugging Face cache/model path;
- API key;
- host bind address and port;
- tensor-parallel and runtime flags.

When additional GPUs are available, record the GPU topology and benchmark
single-process tensor parallelism against independent replicas before adopting
Ray or multi-node execution. Preserve the same OpenAI-compatible endpoint so
the Bazzite-side LiteLLM configuration does not need to change.
