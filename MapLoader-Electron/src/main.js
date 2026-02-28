const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const yaml = require("yaml");
const path = require("node:path");
const unzipper = require("unzipper");
const zlib = require("node:zlib");
const fs = require("node:fs");
const { spawn, exec } = require("child_process");
const http = require("http");
// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (require("electron-squirrel-startup")) {
  app.quit();
}
import { generateThumbnail } from "./utils/create_thumbnail.js";

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.listen(0, () => {
      const port = server.address().port;
      server.close(() => {
        resolve(port);
      });
    });
    server.on("error", (err) => {
      reject(err);
    });
  });
}

const createWindow = () => {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      preload: MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY,
      devTools: false
    },
    title: "Map Manager",
  });

  // and load the index.html of the app.
  mainWindow.loadURL(MAIN_WINDOW_WEBPACK_ENTRY);
  mainWindow.removeMenu();
  mainWindow.maximize();
};

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  createWindow();
});

  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and import them here.

function openFolderDialog() {
  let d = dialog.showOpenDialog({
    properties: ["openDirectory"],
  });
  return d.then((result) => {
    if (!result.canceled) {
      return result.filePaths[0];
    }
    return openFolderDialog();
  }).catch((err) => {
    console.log(err);
    return null;
  });
}

function handleOpenFolder() {
  let val = openFolderDialog();
  return val.then((res) => {
    if(!fs.existsSync(path.join(res, "cities")) || !fs.existsSync(path.join(res, "Local Storage"))) {
      dialog.showMessageBoxSync({
        type: "error",
        title: "Incorrect Folder",
        message: "The folder you selected does not appear to be a valid metro-maker4 folder. Make sure you're selecting a folder that matches the pattern shown in the instructions!",
        buttons: ["Ok"],
        defaultId: 1,
        cancelId: 1
      })
      return handleOpenFolder();
    } else {
      return res;
    }
  }).catch((err) => {
    console.error("Error opening folder dialog:", err);
  });
}

ipcMain.on("open-folder-dialog", (event) => {
  handleOpenFolder().then((val) => {
    event.returnValue = val;
  });
});

function openFileDialog() {
  let d = dialog.showOpenDialog({
    properties: ["openFile"],
  });
  return d.then((result) => {
    if (!result.canceled) {
      return result.filePaths[0];
    }
    return openFileDialog();
  }).catch((err) => {
    console.log(err);
    return null;
  });
}

ipcMain.on("open-file-dialog", (event) => {
  openFileDialog().then((val) => {
    event.returnValue = val;
  });
});

ipcMain.handle("select-map-packages", async (event) => {
  let result = await dialog.showOpenDialog({
    properties: ["openFile", "multiSelections"],
    filters: [{ name: "Map Packages", extensions: ["zip"] }],
  });
  if (result.canceled) {
    return Promise.resolve({ status: "err", message: "User cancelled" });
  } else {
    return {
      status: "success",
      message: "Map packages selected successfully!",
      filePaths: result.filePaths,
    }
  }
});

ipcMain.handle("import-new-map", async (event, args) => {
  if (args.length < 3) {
    return Promise.resolve({
      status: "err",
      message: "Must supply app data path, list of existing map codes, and path to map package",
    });
  }
  let filePath = args[2];
  let d = await unzipper.Open.file(filePath);
  let filesFound = [];
  let config = null;
  let thumbnailFound = false;
  for (let i = 0; i < d.files.length; i++) {
    let file = d.files[i];
    if (file.path === "config.json") {
      filesFound.push("config.json");
      config = file;
    }
    if (file.path == "roads.geojson") {
      filesFound.push("roads.geojson");
    } else if (file.path === "runways_taxiways.geojson") {
      filesFound.push("runways_taxiways.geojson");
    } else if (file.path === "demand_data.json") {
      filesFound.push("demand_data.json");
    } else if (file.path.endsWith(".pmtiles")) {
      filesFound.push("tiles");
    } else if (file.path === "buildings_index.json") {
      filesFound.push("buildings_index.json");
    }
    else if (file.path.endsWith(".svg")) {
      thumbnailFound = true;
    }
    if (thumbnailFound && filesFound.length == 6) {
      break;
    }
  }
  if (filesFound.length < 6) {
    console.log(filesFound);
    return Promise.resolve({
      status: "err",
      message:
        "The selected map package is missing the following required files: " +
        [
          "roads.geojson",
          "runways_taxiways.geojson",
          "demand_data.json",
          "buildings_index.json",
          "config.json",
          "tiles",
        ]
          .filter((f) => !filesFound.includes(f))
          .join(", "),
    });
  }
  let buffer = await config.buffer();
  try {
    config = JSON.parse(buffer.toString());
  } catch (err) {
    console.error("Error parsing config.json:", err);
    return Promise.resolve({
      status: "err",
      message: "Error parsing config.json: " + err.message,
    });
  }
  if (
    config.name === undefined ||
    config.creator === undefined ||
    config.version === undefined ||
    config.description === undefined ||
    config.population === undefined ||
    config.code === undefined ||
    config.initialViewState === undefined
  ) {
    return Promise.resolve({
      status: "err",
      message:
        "The config.json file is missing the following required fields: " +
        [
          "name",
          "creator",
          "version",
          "description",
          "population",
          "code",
          "initialViewState",
        ]
          .filter((f) => config[f] === undefined)
          .join(", "),
    });
  }
  let citiesList = Object.keys(yaml.parse(fs.readFileSync(path.join(args[0], "cities", "latest-cities.yml"), "utf8")).cities);
  let mapCode = config.code;
  console.log("Checking if map code " + mapCode + " already exists in cities/data and in currently loaded maps");
  if (args[1].includes(mapCode)) {
    return Promise.resolve({
      status: "err",
      message:
        "A map with the code " +
        mapCode +
        " already exists. Please choose a different map code or delete the existing map.",
    });
  } else if(citiesList.includes(mapCode)) {
    console.log("Map code " + mapCode + " already exists in cities/data.");
    await dialog.showMessageBox({
      type: "warning",
      title: "Map already exists",
      message: "A vanilla map with the code " + mapCode + " already exists, and will not be overwritten. If you really want to install this, you can do so manually yourself, but know that you may brick the vanilla map.",
      buttons: ["Ok"],
    });
    return Promise.resolve({
      status: "err",
      message: "Vanilla map already exists with this code."
    });
  }
  let mapPath = path.join(args[0], "cities", "data", mapCode);
  if (!fs.existsSync(mapPath)) {
    fs.mkdirSync(mapPath, { recursive: true });
  }
  let promises = [];
  d.files.forEach((f) => {
    if (f.path === "config.json") {
      return;
    }
    let s = f.stream();
    if (f.path.endsWith(".pmtiles")) {
      if (!fs.existsSync(path.join(app.getPath("userData"), "tiles"))) {
        fs.mkdirSync(path.join(app.getPath("userData"), "tiles"));
      }
      let writeStream = s.pipe(
        fs.createWriteStream(
          path.join(app.getPath("userData"), "tiles", `${config.code}.pmtiles`),
          {},
        ),
      );
      promises.push(
        new Promise((resolve, reject) => {
          writeStream.on("finish", () => {
            console.log(`Finished writing ${f.path}`);
            resolve();
          });
          writeStream.on("error", (err) => {
            console.error(`Error writing ${f.path}:`, err);
            reject(err);
          });
        }),
      );
      writeStream.on("finish", () => {
        console.log(`Finished writing ${f.path}`);
      });
      writeStream.on("error", (err) => {
        console.error(`Error writing ${f.path}:`, err);
      });
      return;
    } else if (f.path.endsWith(".svg")) {
      if (
        !fs.existsSync(path.join(args[0], "public", "data", "city-maps"))
      ) {
        fs.mkdirSync(path.join(args[0], "public", "data", "city-maps"), {
          recursive: true,
        });
      }
      let writeStream = s.pipe(
        fs.createWriteStream(
          path.join(
            path.join(args[0], "public", "data", "city-maps"),
            `${config.code}.svg`,
          ),
          {},
        ),
      );
      writeStream.on("finish", () => {
        console.log(`Finished writing ${f.path}`);
      });
      writeStream.on("error", (err) => {
        console.error(`Error writing ${f.path}:`, err);
      });
      return;
    }
    let writeStream = s
      .pipe(zlib.createGzip())
      .pipe(fs.createWriteStream(path.join(mapPath, f.path + ".gz"), {}));
    writeStream.on("finish", () => {
      console.log(`Finished writing ${f.path}`);
    });
    writeStream.on("error", (err) => {
      console.error(`Error writing ${f.path}:`, err);
    });
  });
  if(config.thumbnailBbox && !thumbnailFound) {
    console.log("No thumbnail found, generating one using the bbox in config.json");
    let pmtilesExecPath = path.join(
      app.isPackaged ? process.resourcesPath : __dirname + "/../../",
      process.platform !== "win32" ? "pmtiles" : "pmtiles.exe",
    );
    let port = await getFreePort();
    let pmtiles = spawn(pmtilesExecPath, ["serve", path.join(app.getPath("userData"), "tiles"), "--port", port, "--cors=*"]);
    let thumbnail = await generateThumbnail(config.code, config, port);
    if(thumbnail instanceof Error) {
      console.error("Error generating thumbnail:", thumbnail);
    } else {
      if(!fs.existsSync(path.join(args[0], "public", "data", "city-maps"))) {
        fs.mkdirSync(path.join(args[0], "public", "data", "city-maps"), {
          recursive: true,
        });
      }
      let s = fs.createWriteStream(path.join(args[0], "public", "data", "city-maps", `${config.code}.svg`));
      s.write(thumbnail, (err) => {
        if (err) {
          console.error("Error writing generated thumbnail:", err);
          s.destroy(err);
        }
        else {
          s.end();
        }
      });
      let p = new Promise((resolve, reject) => {
        s.on("finish", () => {
          console.log("Finished writing generated thumbnail");
          pmtiles.kill();
          console.log("rizz");
          resolve();
        });
        s.on("error", (err) => {
          console.error("Error writing generated thumbnail:", err);
          reject(err);
        });
      });
      promises.push(p);
    }
  }
  return Promise.all(promises).then((err) => {
    if(err && err.some(e => e instanceof Error)) {
      console.error("Error importing map:", err);
      return {
        status: "err",
        message: "Error importing map: " + err.message,
      };
    }
    return Promise.resolve({
      status: "success",
      message: "Map imported successfully!",
      config: config,
    });
  });
});

ipcMain.on("delete-map", (event, args) => {
  if (args.length < 2) {
    event.returnValue = {
      status: "err",
      message: "Not enough arguments provided",
    };
    return;
  }
  let mapCode = args[0];
  let appDataPath = args[1];
  let mapPath = path.join(appDataPath, "cities", "data", mapCode);
  let tilesPath = path.join(
    app.getPath("userData"),
    "tiles",
    mapCode + ".pmtiles",
  );
  fs.rmSync(tilesPath, { force: true });
  if (fs.existsSync(mapPath)) {
    fs.rmSync(mapPath, { recursive: true });
    event.returnValue = {
      status: "success",
      message: "Map deleted successfully!",
    };
  } else {
    event.returnValue = { status: "err", message: "Map not found" };
  }
});

ipcMain.on("write-log-file", (event, args) => {
  if (args.length < 2) {
    event.returnValue = {
      status: "err",
      message: "Not enough arguments provided",
    };
    return;
  }
  let message = args[0];
  let filename = args[1];
  if(!fs.existsSync(path.join(app.getPath("userData"), "logs"))) {
    fs.mkdirSync(path.join(app.getPath("userData"), "logs"));
  }
  try {
    fs.writeFileSync(path.join(app.getPath("userData"), "logs", filename), message + "\n");
    event.returnValue = {
      status: "success",
      message: "Log file written successfully",
      filepath: path.join(app.getPath("userData"), "logs", filename),
    };
  } catch (err) {
    console.error("Error writing log file:", err);
    event.returnValue = {
      status: "err",
      message: "Error writing log file",
    };
  }
});

const MOD_CONTENTS = `
const config = \${REPLACE};
function getFlagEmoji (countryCode) {
	let codePoints = countryCode.toUpperCase().split('').map(char =>  127397 + char.charCodeAt());
	return String.fromCodePoint(...codePoints);
}

function getCountryName(countryCode) {
    const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });
    return regionNames.of(countryCode.toUpperCase());
}

function generateTabs(places) {
  let tabs = {};
  places.forEach(place => {
    if(place.country === undefined || place.country.toUpperCase() === "US" || place.country.toUpperCase() === "GB") { // don't make tabs for these, we will have to do these on an upcoming update
      return;
    }
    if(tabs.hasOwnProperty(place.country)) {
      tabs[place.country].push(place.code);
    } else {
      tabs[place.country] = [place.code];
    }
  });
  return tabs;
}

config.places.forEach(async place => {
    let publicDir = await window.electron.getModsFolder();
    publicDir = publicDir.replaceAll('\\\\', '/').replace("/mods", '/public/data/city-maps/');
    let newPlace = {
        code: place.code,
        name: place.name,
        population: place.population,
        description: place.description,
        mapImageUrl: \`file:///\${publicDir}\${place.code}.svg\` // Tries to pull this from the app.asar instead of public/
    };
    if (place.initialViewState) {
        newPlace.initialViewState = place.initialViewState;
    } else {
        newPlace.initialViewState = {
            longitude: (place.bbox[0] + place.bbox[2]) / 2,
            latitude: (place.bbox[1] + place.bbox[3]) / 2,
            zoom: 12,
            bearing: 0,
        };
    }
    window.SubwayBuilderAPI.registerCity(newPlace);
    window.SubwayBuilderAPI.map.setDefaultLayerVisibility(place.code, {
        oceanFoundations: false,
        trackElevations: false
    });
    // 3. Fix layer schemas for custom tiles
    window.SubwayBuilderAPI.map.setLayerOverride({
        layerId: 'parks-large',
        sourceLayer: 'landuse',
        filter: ['==', ['get', 'kind'], 'park'],
    });

    window.SubwayBuilderAPI.map.setLayerOverride({
        layerId: 'airports',
        sourceLayer: 'landuse',
        filter: ['==', ['get', 'kind'], 'aerodrome'],
    });

    window.SubwayBuilderAPI.map.setTileURLOverride({
        cityCode: place.code,
        tilesUrl: \`http://127.0.0.1:\${config.port}/\${place.code}/{z}/{x}/{y}.mvt\`,
        foundationTilesUrl: \`https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png\`,
        maxZoom: config["tile-zoom-level"]
    });

    window.SubwayBuilderAPI.cities.setCityDataFiles(place.code, { // auto appends .gz, is this intended? if it is then its fine if not then that has to be removed so we can manually set the .gz file extension
        buildingsIndex: \`/data/\${place.code}/buildings_index.json\`,
        demandData: \`/data/\${place.code}/demand_data.json\`, // drivingPaths supplied in demand_data.json.gz still aren't used
        roads: \`/data/\${place.code}/roads.geojson\`,
        runwaysTaxiways: \`/data/\${place.code}/runways_taxiways.geojson\`,
    })
})
    
let tabs = generateTabs(config.places);
Object.entries(tabs).forEach(([country, codes]) => {
    window.SubwayBuilderAPI.cities.registerTab({
      id: country,
      label: getCountryName(country),
      emoji: getFlagEmoji(country),
      cityCodes: codes,
    });
});`;

const manifest = {
  id: "com.kronifer.maploader",
  name: "Map Loader",
  description: "Patcher-like mod that allows easy loading of custom maps.",
  version: "1.0.0",
  author: { name: "Kronifer" },
  main: "index.js",
};

ipcMain.on("start-game", async (event, args) => {
  if (args.length < 3) {
    event.returnValue = {
      status: "err",
      message: "Not enough arguments provided",
    };
    return;
  }
  let gamePath = args[0];
  let appDataPath = args[1];
  let mapConfig = args[2];
  let openPort = await getFreePort();
  let config = {places: mapConfig, "tile-zoom-level": 15, port: openPort};
  if(!fs.existsSync(path.join(appDataPath, "mods", "mapLoader"))) {
    fs.mkdirSync(path.join(appDataPath, "mods", "mapLoader"), { recursive: true });
  }
  fs.writeFileSync(path.join(appDataPath, "mods", "mapLoader", "manifest.json"), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(appDataPath, "mods", "mapLoader", "index.js"), MOD_CONTENTS.replace("${REPLACE}", JSON.stringify(config)));
  let pmtilesExecPath = path.join(
    app.isPackaged ? process.resourcesPath : __dirname + "/../../",
    process.platform !== "win32" ? "pmtiles" : "pmtiles.exe",
  );
  let game;
  if(process.platform !== "darwin") {
    try {
      game = spawn(gamePath);
    } catch (err) {
      console.error("Error starting game:", err);
      event.returnValue = {
        status: "err",
        message: "Error starting game: " + err.message,
      };
      return;
    }
  } else {
    try {       
      game = spawn("open", ["-W", "-a", gamePath]);
    } catch (err) {
      console.error("Error starting game:", err);
      event.returnValue = {
        status: "err",
        message: "Error starting game: " + err.message,
      };
      return;
    }
  }
  let pmtiles = spawn(pmtilesExecPath, ["serve", path.join(app.getPath("userData"), "tiles"), "--port", openPort, "--cors=*"]);
  console.log(
    `Started game with PID ${game.pid} and pmtiles with PID ${pmtiles.pid}`,
  );
  pmtiles.stdout.on("data", (data) => {
    console.log(`pmtiles: ${data}`);
  });
  pmtiles.stderr.on("data", (data) => {
    console.error(`pmtiles error: ${data}`);
  });
  game.on("close", () => {
    pmtiles.kill();
  });
  event.returnValue = {
    status: "success",
    message: "Game started successfully!",
  };
});
