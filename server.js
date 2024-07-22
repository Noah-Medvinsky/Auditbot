const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const OpenAI = require('openai');
const toml = require('toml');
const { execSync } = require('child_process');

const app = express();
const port = process.env.PORT || 3000;

// Read the secrets from secrets.toml
const secretsPath = path.join(__dirname, 'secrets.toml');
const secrets = toml.parse(fs.readFileSync(secretsPath, 'utf8'));

const openai = new OpenAI({
    apiKey: secrets.OPENAI,
});

const ETHERSCAN_API_KEY = secrets.ETHERSCAN_KEY;

app.use(bodyParser.json());
app.use(express.static('public'));

// Serve the frontend
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Serve the analysis results page from the public directory
app.get('/results', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'results.html'));
});

app.post('/analyze', async (req, res) => {
    const contractAddress = req.body.address;

    try {
        const fetchContractSourceCode = async (address) => {
            const response = await axios.get('https://api.etherscan.io/api', {
                params: {
                    module: 'contract',
                    action: 'getsourcecode',
                    address: address,
                    apiKey: ETHERSCAN_API_KEY
                }
            });
            return response.data;
        };

        let etherscanResponse;
        try {
            etherscanResponse = await fetchContractSourceCode(contractAddress);
        } catch (error) {
            if (error.response && error.response.status === 502) {
                console.log('502 error encountered. Retrying...');
                etherscanResponse = await fetchContractSourceCode(contractAddress);
            } else {
                throw error;
            }
        }

        console.log("Etherscan API Response:", etherscanResponse);

        if (etherscanResponse.status !== "1") {
            console.error("Etherscan API Error:", etherscanResponse.result);
            return res.status(400).json({ error: 'Failed to fetch source code from Etherscan.' });
        }

        let sourceCode = etherscanResponse.result[0].SourceCode;
        const fallbackCompilerVersion = etherscanResponse.result[0].CompilerVersion;

        if (!sourceCode) {
            return res.status(400).json({ error: 'Source code not found for the given contract address.' });
        }

        console.log("Received Source Code:", sourceCode);
        console.log("Fallback Compiler Version:", fallbackCompilerVersion);

        if (sourceCode.startsWith('{') && sourceCode.endsWith('}')) {
            try {
                const parsed = JSON.parse(sourceCode);
                sourceCode = parsed.sources ? Object.values(parsed.sources).map(src => src.content).join('\n') : parsed.sourceCode || '';
            } catch (error) {
                console.error("Error parsing JSON source code:", error);
                return res.status(400).json({ error: 'Failed to parse JSON source code.' });
            }
        }

        const pragmaMatch = sourceCode.match(/pragma solidity\s+([^;]+);/);
        let solcVersion = pragmaMatch ? pragmaMatch[1].replace(/[^\d.]/g, '') : null;

        if (!solcVersion) {
            console.error("Pragma solidity version not found in source code:", sourceCode);
            if (fallbackCompilerVersion) {
                solcVersion = fallbackCompilerVersion.match(/^v?(\d+\.\d+\.\d+)/)[1];
                console.log("Using fallback compiler version:", solcVersion);
            } else {
                return res.status(400).json({ error: 'Solidity version not found in contract and no fallback version available.' });
            }
        }

        console.log("Detected Solidity Version:", solcVersion);

        const isSolcVersionInstalled = (version) => {
            try {
                const installedVersions = execSync('solc-select versions').toString();
                return installedVersions.includes(version);
            } catch (error) {
                return false;
            }
        };

        const installAndSwitchSolcVersion = (version) => {
            try {
                execSync(`solc-select install ${version}`);
                execSync(`solc-select use ${version}`);
            } catch (error) {
                throw new Error(`Failed to install or switch to solc version ${version}: ${error.message}`);
            }
        };

        if (!isSolcVersionInstalled(solcVersion)) {
            console.log(`Solc version ${solcVersion} not found. Installing...`);
            installAndSwitchSolcVersion(solcVersion);
            console.log(`Switched to solc version ${solcVersion}`);
        } else {
            console.log(`Solc version ${solcVersion} is already installed. Switching...`);
            execSync(`solc-select use ${solcVersion}`);
        }

        sourceCode = sourceCode.replace(/\/\*\*[\s\S]*?\*\//g, '').trim();

        const contractPath = path.join(__dirname, 'contract.sol');
        fs.writeFileSync(contractPath, sourceCode, 'utf8');

        const writtenSourceCode = fs.readFileSync(contractPath, 'utf8');
        console.log("Contract File Contents:\n", writtenSourceCode);

        const slitherCommand = `"C:\\Users\\Noah Medvinsky\\AppData\\Local\\Packages\\PythonSoftwareFoundation.Python.3.12_qbz5n2kfra8p0\\LocalCache\\local-packages\\Python312\\Scripts\\slither.exe" "${contractPath}"`;
        let slitherResult;
        try {
            slitherResult = execSync(slitherCommand, { stdio: 'pipe' }).toString();
            console.log("Slither Analysis:\n" + slitherResult);
        } catch (error) {
            slitherResult = error.stdout.toString() + '\n' + error.stderr.toString();
            console.log("Slither Analysis with Warnings:\n" + slitherResult);
        }

        const promptContent = `
You are a smart contract auditor. Analyze the following Solidity code for vulnerabilities such as overflow/underflow, reentrancy, and timestamp dependency. Provide detailed explanations for each identified vulnerability, categorize the issues into "## Security Issues", "## Code Quality Issues", and include a section for "## Solutions" to address the identified issues with clear code examples. Highlight the most pressing issues using **bold text**. Ensure the response is well-structured, using markdown format with appropriate section headings.

Here is the contract code:
\`\`\`solidity
${sourceCode}
\`\`\`

Here is Slither's Analysis:
                
\`\`\`
${slitherResult}
\`\`\`
`;

        const response = await openai.chat.completions.create({
            model: "gpt-4-turbo",
            messages: [
                { role: "system", content: "You are an assistant that helps analyze Solidity smart contracts." },
                { role: "user", content: promptContent },
            ],
        });

        const analysis = response.choices[0].message.content;

        console.log("FULL ANALYSIS: " + analysis);

        fs.writeFileSync(path.join(__dirname, 'public', 'analysis.json'), JSON.stringify({ analysis }), 'utf8');

        res.json({ success: true });
    } catch (error) {
        console.error("Error:", error);
        if (!res.headersSent) {
            res.status(500).json({ error: 'Something went wrong!' });
        }
    }
});

app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});
