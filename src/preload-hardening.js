"use strict";

const serverPath = require.resolve("./server");
const production = require("./server-production");

require.cache[serverPath] = {
    id: serverPath,
    filename: serverPath,
    loaded: true,
    exports: production,
    children: [],
    paths: module.paths
};
