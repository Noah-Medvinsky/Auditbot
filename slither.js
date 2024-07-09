const { exec } = require('child_process');
const path = require('path');
const util = require('util');
const fs = require('fs');
const solc = require('solc');

const execPromise = util.promisify(exec);

// Replace with the full path to Slither executable
const slitherPath = path.join(
    "C:", "Users", "Noah Medvinsky", "AppData", "Local", "Packages", "PythonSoftwareFoundation.Python.3.12_qbz5n2kfra8p0", "LocalCache", "local-packages", "Python312", "Scripts", "slither.exe"
);

async function getSolidityVersion(contractPath) {
    const content = fs.readFileSync(contractPath, 'utf8');
    const versionMatch = content.match(/pragma solidity \^(.*?);/);
    if (versionMatch) {
        return versionMatch[1];
    }
    throw new Error('Solidity version not found in contract');
}

async function loadSolcVersion(version) {
    return new Promise((resolve, reject) => {
        solc.loadRemoteVersion(`v${version}`, (err, solcSpecific) => {
            if (err) {
                return reject(err);
            }
            resolve(solcSpecific);
        });
    });
}

async function switchSolcVersion(version) {
    await execPromise(`solc-select use ${version}`);
    console.log(`Switched to solc version ${version}`);
}

async function testexec() {
    const contractPath = path.join(__dirname, 'contract.sol');
    let solcVersion;

    try {
        solcVersion = await getSolidityVersion(contractPath);
        await switchSolcVersion(solcVersion);
        
        const { stdout, stderr } = await execPromise(`"${slitherPath}" "${contractPath}"`);
        
        // Combine stdout and stderr
        const combinedOutput = stdout + stderr;

        // Remove duplicate lines
        const uniqueLines = Array.from(new Set(combinedOutput.split('\n'))).join('\n');

        // Log raw outputs separately with additional context
        console.log("Raw Stdout:", stdout ? `\n--- Start of Stdout ---\n${stdout}\n--- End of Stdout ---` : "No Stdout");
        console.error("Raw Stderr:", stderr ? `\n--- Start of Stderr ---\n${stderr}\n--- End of Stderr ---` : "No Stderr");

        return uniqueLines;
    } catch (error) {
        // Include stdout and stderr from the error object if they exist
        const errorOutput = (error.stdout ? error.stdout : '') + (error.stderr ? error.stderr : '');
        const combinedErrorOutput = `Error executing command: ${error.message}\n${errorOutput}`;
        
        // Remove duplicate lines in case of error
        const uniqueLines = Array.from(new Set(combinedErrorOutput.split('\n'))).join('\n');
        
        return uniqueLines;
    }
}
/*
async function test(){
    let print = await testexec();
    console.log("result is "+print);
}
test();
*/
module.exports = testexec;
