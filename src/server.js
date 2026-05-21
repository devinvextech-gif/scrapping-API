import express from "express";
import cors from "cors";
import router from "./route/index.js";

const app = express();
app.use(cors());
app.use(express.json());

app.use(router);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Browser worker running on port ${PORT}`);
});
