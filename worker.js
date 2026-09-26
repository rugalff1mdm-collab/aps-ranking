import { httpServerHandler } from "cloudflare:node";

// O backend Express existente continua sendo usado no Worker.
// O Cloudflare faz a ponte entre Fetch/Workers e o servidor HTTP do Express.
import "./server.js";

export default httpServerHandler({ port: 3000 });
