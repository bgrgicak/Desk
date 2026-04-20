import { createServer } from "./server.js";

const port = parseInt(process.env.PORT || "8080", 10);
const server = createServer();

server.listen(port, () => {
  console.log(`desk-server listening on port ${port}`);
});
