"use strict";
const express = require("express");
function attach(app) {
  const router = express.Router();
  router.use((req, res, next) =>
    Promise.resolve()
      .then(async () => {
        if (!req.sdcActor)
          await require("../auth/guard").resolveSession(req, res);
      })
      .then(() => next(), next),
  );
  router.use(require("./notifications").locals);
  for (const module of [
    "./patient",
    "./accounts",
    "./billing",
    "./staff",
    "./jobs",
    "./admin",
    "./settlements",
    "./ai",
    "./notifications",
    "./support",
  ])
    require(module).attach(router);
  app.use(router);
}
module.exports = { attach };
