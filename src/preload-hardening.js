"use strict";

const serverPath = require.resolve("./server");
const hardened = require("./server-hardened");

require.cache[serverPath] = {
    id: serverPath,
    filename: serverPath,
    loaded: true,
    exports: hardened,
    children: [],
    paths: module.paths
};
