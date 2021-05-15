const isWin = require("os").platform() === "win32";
const got = require("got");
const glob = require("glob");
const url = require("url");
const util = require("util");
const stream = require("stream");
const fs = require("fs");
const path = require("path");
const os = require("os");
const tar = require("tar");

const pipeline = util.promisify(stream.pipeline);

let dockerConn = undefined;

// Debug mode flag
const DEBUG_MODE =
  process.env.SCAN_DEBUG_MODE === "debug" ||
  process.env.SHIFTLEFT_LOGGING_LEVEL === "debug";

/**
 * Method to get all dirs matching a name
 *
 * @param {string} dirPath Root directory for search
 * @param {string} dirName Directory name
 */
const getDirs = (dirPath, dirName, hidden = false) => {
  try {
    return glob.sync("**/" + dirName, {
      cwd: dirPath,
      silent: true,
      absolute: true,
      nocase: true,
      nodir: false,
      follow: false,
      dot: hidden,
    });
  } catch (err) {
    console.error(err);
    return [];
  }
};
exports.getDirs = getDirs;

const getDefaultOptions = () => {
  let opts = {
    throwHttpErrors: true,
    "hooks.beforeError": [],
    method: "GET",
  };

  if (!process.env.DOCKER_HOST) {
    opts.prefixUrl = isWin
      ? "npipe://./pipe/docker_engine:"
      : "unix:/var/run/docker.sock:";
  } else {
    let hostStr = process.env.DOCKER_HOST;
    opts.prefixUrl = hostStr;
    if (process.env.DOCKER_CERT_PATH) {
      opts.https = {
        certificate: fs.readFileSync(
          path.join(process.env.DOCKER_CERT_PATH, "cert.pem"),
          "utf8"
        ),
        key: fs.readFileSync(
          path.join(process.env.DOCKER_CERT_PATH, "key.pem"),
          "utf8"
        ),
      };
    }
  }

  return opts;
};

const getConnection = async (options) => {
  if (!dockerConn) {
    const opts = Object.assign({}, getDefaultOptions(), options);
    try {
      const res = await got.get("_ping", opts);
      dockerConn = got.extend(opts);
    } catch (err) {
      if (err && err.code === "ECONNREFUSED") {
        console.warn("Ensure docker service or Docker for Desktop is running");
      } else {
        console.error(opts, err);
      }
    }
  }
  return dockerConn;
};
exports.getConnection = getConnection;

const makeRequest = async (path, method = "GET") => {
  let client = await getConnection();
  if (!client) {
    return undefined;
  }
  const extraOptions = {
    responseType: method === "GET" ? "json" : "text",
    resolveBodyOnly: true,
    method,
  };
  const opts = Object.assign({}, getDefaultOptions(), extraOptions);
  return await client(path, opts);
};
exports.makeRequest = makeRequest;

/**
 * Parse image name
 *
 * docker pull debian
 * docker pull debian:jessie
 * docker pull ubuntu@sha256:45b23dee08af5e43a7fea6c4cf9c25ccf269ee113168c19722f87876677c5cb2
 * docker pull myregistry.local:5000/testing/test-image
 */
const parseImageName = (fullName) => {
  const nameObj = {
    registry: "",
    repo: "",
    tag: "",
    digest: "",
    platform: "",
  };
  if (!fullName) {
    return nameObj;
  }
  // Extract registry name
  if (
    fullName.includes("/") &&
    (fullName.includes(".") || fullName.includes(":"))
  ) {
    const urlObj = url.parse(fullName);
    const tmpA = fullName.split("/");
    if (
      urlObj.path !== fullName ||
      tmpA[0].includes(".") ||
      tmpA[0].includes(":")
    ) {
      nameObj.registry = tmpA[0];
      fullName = fullName.replace(tmpA[0] + "/", "");
    }
  }
  // Extract digest name
  if (fullName.includes("@sha256:")) {
    const tmpA = fullName.split("@sha256:");
    if (tmpA.length > 1) {
      nameObj.digest = tmpA[tmpA.length - 1];
      fullName = fullName.replace("@sha256:" + nameObj.digest, "");
    }
  }
  // Extract tag name
  if (fullName.includes(":")) {
    const tmpA = fullName.split(":");
    if (tmpA.length > 1) {
      nameObj.tag = tmpA[tmpA.length - 1];
      fullName = fullName.replace(":" + nameObj.tag, "");
    }
  }
  // The left over string is the repo name
  nameObj.repo = fullName;
  return nameObj;
};
exports.parseImageName = parseImageName;

/**
 * Method to get image to the local registry by pulling from the remote if required
 */
const getImage = async (fullName) => {
  let localData = undefined;
  const { repo, tag, digest } = parseImageName(fullName);
  // Fetch only the latest tag if none is specified
  if (tag === "" && digest === "") {
    fullName = fullName + ":latest";
  }
  try {
    localData = await makeRequest(`images/${repo}/json`);
    if (DEBUG_MODE) {
      console.log(localData);
    }
  } catch (err) {
    console.log(
      `Trying to pull the image ${fullName} from registry. This might take a while ...`
    );
    // If the data is not available locally
    try {
      const pullData = await makeRequest(
        `images/create?fromImage=${fullName}`,
        "POST"
      );
      if (DEBUG_MODE) {
        console.log(pullData);
      }
      try {
        if (DEBUG_MODE) {
          console.log(`Trying with ${repo}`);
        }
        localData = await makeRequest(`images/${repo}/json`);
        if (DEBUG_MODE) {
          console.log(localData);
        }
      } catch (err) {
        if (DEBUG_MODE) {
          console.log(`Retrying with ${fullName}`);
        }
        localData = await makeRequest(`images/${fullName}/json`);
        if (DEBUG_MODE) {
          console.log(localData);
        }
      }
    } catch (err) {
      console.log(`Unable to pull the image ${repo}`);
      console.error(err);
    }
  }
  return localData;
};
exports.getImage = getImage;

/**
 * Method to export a container image by untarring. Returns the location of the layers with additional packages related metadata
 */
const exportImage = async (fullName) => {
  // Try to get the data locally first
  const localData = await getImage(fullName);
  if (!localData) {
    return undefined;
  }
  const { repo, tag, digest } = parseImageName(fullName);
  // Fetch only the latest tag if none is specified
  if (tag === "" && digest === "") {
    fullName = fullName + ":latest";
  }
  let client = await getConnection();
  let manifest = {};
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "docker-images-"));
  const allLayersExplodedDir = path.join(tempDir, "all-layers");
  fs.mkdirSync(allLayersExplodedDir);
  const manifestFile = path.join(tempDir, "manifest.json");
  try {
    console.log(`About to export image ${fullName} to ${tempDir}`);
    await pipeline(
      client.stream(`images/${fullName}/get`),
      tar.x({
        sync: true,
        C: tempDir,
      })
    );
    if (fs.existsSync(tempDir) && fs.existsSync(manifestFile)) {
      if (DEBUG_MODE) {
        console.log(
          `Image ${fullName} successfully exported to directory ${tempDir}`
        );
      }
      manifest = JSON.parse(
        fs.readFileSync(manifestFile, {
          encoding: "utf-8",
        })
      );
      if (manifest.length !== 1) {
        if (DEBUG_MODE) {
          console.log(
            "Multiple image tags was downloaded. Only the last one would be used"
          );
          console.log(manifest[manifest.length - 1]);
        }
      }
      const layers = manifest[manifest.length - 1]["Layers"];
      const lastLayer = layers[layers.length - 1];
      for (let layer of layers) {
        if (DEBUG_MODE) {
          console.log(`Extracting ${layer} to ${allLayersExplodedDir}`);
        }
        await pipeline(
          fs.createReadStream(path.join(tempDir, layer)),
          tar.x({
            sync: true,
            C: allLayersExplodedDir,
          })
        );
      }
      const lastLayerConfigFile = path.join(
        tempDir,
        lastLayer.replace("layer.tar", "json")
      );
      let lastLayerConfig = {};
      if (fs.existsSync(lastLayerConfigFile)) {
        lastLayerConfig = JSON.parse(
          fs.readFileSync(lastLayerConfigFile, {
            encoding: "utf-8",
          })
        );
      }
      const exportData = {
        inspectData: localData,
        manifest: manifest,
        allLayersDir: tempDir,
        allLayersExplodedDir,
        lastLayerConfig,
      };
      exportData.pkgPathList = getPkgPathList(exportData);
      return exportData;
    } else {
      console.log(`Unable to export image to ${tempDir}`);
    }
  } catch (err) {
    console.error(err);
  }
  return undefined;
};
exports.exportImage = exportImage;

/**
 * Method to retrieve path list for system-level packages
 */
const getPkgPathList = (exportData) => {
  const allLayersExplodedDir = exportData.allLayersExplodedDir;
  const allLayersDir = exportData.allLayersDir;
  const lastWorkingDir = exportData.lastLayerConfig.config.WorkingDir;
  let pathList = [];
  const knownSysPaths = [
    path.join(allLayersExplodedDir, lastWorkingDir),
    path.join(allLayersExplodedDir, "/usr/lib"),
    path.join(allLayersExplodedDir, "/usr/lib64"),
    path.join(allLayersExplodedDir, "/usr/local/lib"),
    path.join(allLayersExplodedDir, "/usr/local/lib64"),
    path.join(allLayersExplodedDir, "/opt"),
    path.join(allLayersExplodedDir, "/home"),
    path.join(allLayersExplodedDir, "/usr/share"),
    path.join(allLayersExplodedDir, "/var/www/html"),
    path.join(allLayersExplodedDir, "/var/lib"),
    path.join(allLayersExplodedDir, "/mnt"),
    path.join(allLayersExplodedDir, "/app"),
    path.join(allLayersExplodedDir, "/data"),
    path.join(allLayersExplodedDir, "/srv"),
  ];
  // Build path list
  for (let wpath of knownSysPaths) {
    pathList = pathList.concat(wpath);
    const pyDirs = getDirs(wpath, "site-packages", false);
    if (pyDirs && pyDirs.length) {
      pathList = pathList.concat(pyDirs);
    }
    const gemsDirs = getDirs(wpath, "gems", false);
    if (gemsDirs && gemsDirs.length) {
      pathList = pathList.concat(gemsDirs);
    }
    const cargoDirs = getDirs(wpath, ".cargo", true);
    if (cargoDirs && cargoDirs.length) {
      pathList = pathList.concat(cargoDirs);
    }
    const composerDirs = getDirs(wpath, ".composer", true);
    if (composerDirs && composerDirs.length) {
      pathList = pathList.concat(composerDirs);
    }
  }
  return pathList;
};
exports.getPkgPathList = getPkgPathList;

const removeImage = async (fullName, force = false) => {
  const removeData = await makeRequest(
    `images/${fullName}?force=${force}`,
    "DELETE"
  );
  if (DEBUG_MODE) {
    console.log(removeData);
  }
  return removeData;
};
exports.removeImage = removeImage;
