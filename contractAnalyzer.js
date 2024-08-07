const axios = require("axios");
const toml = require("toml");
const fs = require("fs");
const path = require("path");
const { exec, execSync } = require("child_process");
const util = require("util");

// Load secrets from secrets.toml
const secretsPath = path.join(__dirname, "secrets.toml");
const secrets = toml.parse(fs.readFileSync(secretsPath, "utf8"));
const BASESCAN_API_KEY = secrets.BASESCAN_KEY;

// Function to fetch contract source code from BaseScan
const fetchContractSourceCode = async (address) => {
  const response = await axios.get("https://api.basescan.org/api", {
    params: {
      module: "contract",
      action: "getsourcecode",
      address: address,
      apiKey: BASESCAN_API_KEY,
    },
  });
  return response.data;
};

// Function to install and switch to a specific solc version
const installAndSwitchSolcVersion = (version) => {
  try {
    execSync(`solc-select install ${version}`);
    execSync(`solc-select use ${version}`);
  } catch (error) {
    throw new Error(
      `Failed to install or switch to solc version ${version}: ${error.message}`
    );
  }
};

// Function to check if a specific solc version is installed
const isSolcVersionInstalled = (version) => {
  try {
    const installedVersions = execSync("solc-select versions").toString();
    return installedVersions.includes(version);
  } catch (error) {
    return false;
  }
};

// Function to analyze the contract using Slither
const analyzeContract = async (contractPath, baseDir, remappings1) => {
  const execPromise = util.promisify(exec);
  const allowPaths = `--allow-paths .,${baseDir}`;
  const slitherCommand = `slither "${contractPath}" --solc-remaps "$(tr '\n' ' ' < remappings.txt | xargs)${remappings1}" --solc-args="${allowPaths}"`;

  console.log("Running Slither command:", slitherCommand);
  try {
    const { stdout, stderr } = await execPromise(slitherCommand);
    console.log("Slither analysis stdout:", stdout);
    console.log("Slither analysis stderr:", stderr);

    return stderr;
  } catch (error) {
    return error.stderr ? error.stderr.toString() : "No stderr";
  }
};

// Function to update the path based on presence of node_modules
function updatePath(baseDir, file, libraries, nodeModulesPresent) {
  let absolutePath = path.join(baseDir, file);
  absolutePath = absolutePath.replace(
    /node_modules\/node_modules/g,
    "node_modules"
  );

  if (!nodeModulesPresent) {
    libraries.forEach((library) => {
      if (absolutePath.includes(`${library}/`)) {
        absolutePath = absolutePath.replace(
          `${library}/`,
          `node_modules/${library}/`
        );
      }
    });
  }

  return absolutePath;
}

// Main function to run all tasks
const runAll = async (contractAddress) => {
  try {
    let basescanResponse;
    try {
      basescanResponse = await fetchContractSourceCode(contractAddress);
    } catch (error) {
      if (error.response && error.response.status === 502) {
        console.log("502 error encountered. Retrying...");
        basescanResponse = await fetchContractSourceCode(contractAddress);
      } else {
        throw error;
      }
    }

    if (basescanResponse.status !== "1") {
      console.error("BaseScan API Error:", basescanResponse.result);
      return null;
    }

    let sourceCode = basescanResponse.result[0].SourceCode;
    const fallbackCompilerVersion = basescanResponse.result[0].CompilerVersion;

    if (!sourceCode) {
      console.error("Source code not found for the given contract address.");
      return null;
    }

    //==============================================================
    //test

    data = JSON.parse(sourceCode.replace(/{{/g, "{").replace(/}}/g, "}"));
    let remappings1 = "";

    const remappings = JSON.stringify(data.settings.remappings);
    if (remappings && remappings.trim() !== "[]") {
      const remappings0 = remappings
        .replace(/,/g, " ")
        .replace(/"/g, "")
        .replace(/\[/g, " ")
        .replace(/\]/g, "")
        .replace(/=/g, "=tmp/contracts/");

      const trimmedRemappings1 = remappings0.trim();

      remappings1 = trimmedRemappings1 === "" ? "" : remappings0;
    }
    //test
    //==============================================================

    let parsedSourceCode;
    try {
      if (sourceCode.startsWith("{") && sourceCode.endsWith("}")) {
        parsedSourceCode = JSON.parse(
          sourceCode.replace(/{{/g, "{").replace(/}}/g, "}")
        );
      } else {
        // Wrap the plain Solidity code in an object structure similar to the JSON format
        parsedSourceCode = {
          sources: {
            "Contract.sol": { content: sourceCode },
          },
        };
      }
    } catch (error) {
      console.error("Failed to parse source code JSON.");
      return null;
    }

    const baseDir = path.join("./tmp", "contracts");
    fs.rmSync(baseDir, { recursive: true, force: true });
    fs.mkdirSync(baseDir, { recursive: true });

    const ensureDirectoryExistence = (filePath) => {
      const dirname = path.dirname(filePath);
      if (fs.existsSync(dirname)) {
        return true;
      }
      ensureDirectoryExistence(dirname);
      fs.mkdirSync(dirname);
    };

    const localFiles = [];
    const libraries = new Set();

    Object.keys(parsedSourceCode.sources).forEach((filePath) => {
      if (filePath.startsWith("@")) {
        const libraryName = filePath.split("/")[0];
        libraries.add(libraryName);
      } else {
        localFiles.push(filePath);
      }
    });

    let nodeModulesPresent = false;

    localFiles.forEach((filePath) => {
      const absolutePath = path.join(baseDir, filePath);
      ensureDirectoryExistence(absolutePath);
      fs.writeFileSync(
        absolutePath,
        parsedSourceCode.sources[filePath].content
      );
    });

    const nodeModulesPath = path.join(baseDir, "node_modules");
    if (!fs.existsSync(nodeModulesPath)) {
      fs.mkdirSync(nodeModulesPath);
    } else {
      nodeModulesPresent = true;
    }

    libraries.forEach((library) => {
      const libraryPath = path.join(baseDir, "node_modules", library);
      ensureDirectoryExistence(libraryPath);
      Object.keys(parsedSourceCode.sources).forEach((filePath) => {
        if (filePath.startsWith(library)) {
          const absolutePath = path.join(
            libraryPath,
            filePath.replace(`${library}/`, "")
          );
          ensureDirectoryExistence(absolutePath);
          fs.writeFileSync(
            absolutePath,
            parsedSourceCode.sources[filePath].content
          );
        }
      });
    });

    // Check for libraries in node_modules that are not detected in the source
    const nodeModulesLibraries = fs
      .readdirSync(nodeModulesPath)
      .filter((dir) => dir.startsWith("@"));
    nodeModulesLibraries.forEach((library) => {
      if (!libraries.has(library)) {
        libraries.add(library);
      }
    });

    console.log("Libraries detected:", Array.from(libraries).join(", "));

    const detectSolcVersion = (source) => {
      const pragmaMatch = source.match(/pragma solidity\s+([^;]+);/);
      return pragmaMatch ? pragmaMatch[1].replace(/[^\d.]/g, "") : null;
    };

    let solcVersion = fallbackCompilerVersion.match(/^v?(\d+\.\d+\.\d+)/)[1];
    console.log("solcversion: " + solcVersion);

    if (!isSolcVersionInstalled(solcVersion)) {
      installAndSwitchSolcVersion(solcVersion);
    } else {
      execSync(`solc-select use ${solcVersion}`);
    }

    let slitherResults = "";
    const contractFiles = Object.keys(parsedSourceCode.sources);
    const remapPaths = Array.from(libraries)
      .map(
        (library) => `${library}=${path.join(baseDir, "node_modules", library)}`
      )
      .join(",");

    for (const file of contractFiles) {
      const absolutePath = updatePath(
        baseDir,
        file,
        Array.from(libraries),
        nodeModulesPresent
      );
      try {
        const results = await analyzeContract(
          absolutePath,
          baseDir,
          remappings1
        );
        slitherResults += results + "\n";
      } catch (error) {
        console.error(`Failed to analyze contract file: ${absolutePath}`);
      }
    }

    console.log("FULL ANALYSIS RESULTS:", slitherResults);

    const combinedSourceCode = Object.values(parsedSourceCode.sources)
      .map((src) => src.content)
      .join("\n");

    return { slitherResults, combinedSourceCode };
  } catch (error) {
    console.error("Error:", error);
    return null;
  }
};

//runAll(('0x4c5d8A75F3762c1561D96f177694f67378705E98'));

module.exports = {
  runAll,
};
