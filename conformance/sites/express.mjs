import express from "express";
import { spillway } from "../../ports/node/spillway-express.mjs";

const app = express();
app.use(spillway({ tenant: process.env.T, engineUrl: process.env.E, siteOrigin: "http://localhost:8788" }));
app.all("/{*any}", (req, res) => res.send(req.path.startsWith("/api/") ? "API OK" : "SITE OK"));
app.listen(8788, "127.0.0.1", () => console.log("express test site on 8788"));
