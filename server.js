const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const OpenAI = require('openai');
const testexec = require('./slither');  // Import the testexec function
const toml = require('toml');  // Import the toml parser

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

        // Log the response data to inspect it
        console.log("Etherscan API Response:", etherscanResponse);

        if (etherscanResponse.status !== "1") {
            console.error("Etherscan API Error:", etherscanResponse.result);
            return res.status(400).json({ error: 'Failed to fetch source code from Etherscan.' });
        }

        let sourceCode = etherscanResponse.result[0].SourceCode;

        if (!sourceCode) {
            return res.status(400).json({ error: 'Source code not found for the given contract address.' });
        }

        // Check if the sourceCode is enclosed in a JSON object
        if (sourceCode.startsWith('{') && sourceCode.endsWith('}')) {
            try {
                const parsed = JSON.parse(sourceCode);
                sourceCode = parsed.sourceCode || '';
            } catch (error) {
                console.error("Error parsing JSON source code:", error);
                return res.status(400).json({ error: 'Failed to parse JSON source code.' });
            }
        }

        // Ensure that the pragma solidity statement is correctly formatted
        if (!sourceCode.includes('pragma solidity')) {
            return res.status(400).json({ error: 'Solidity version not found in contract' });
        }

        // Clean up the source code by removing metadata comments and any additional unnecessary information
        sourceCode = sourceCode.replace(/\/\*\*[\s\S]*?\*\//g, '').trim();

        // Write the source code to contract.sol
        const contractPath = path.join(__dirname, 'contract.sol');
        fs.writeFileSync(contractPath, sourceCode, 'utf8');

        // Log the contents of the contract file
        const writtenSourceCode = fs.readFileSync(contractPath, 'utf8');
        console.log("Contract File Contents:\n", writtenSourceCode);

        // Get Slither analysis
        const slitherResult = await testexec(contractPath);
        console.log("Slither Analysis:\n" + slitherResult);

        // Prepare the analysis prompt
        const promptContent = `
        You are a smart contract auditor. Analyze the following Solidity code for vulnerabilities such as overflow/underflow, reentrancy, and timestamp dependency. Provide detailed explanations for each identified vulnerability, categorize the issues into "## Security Issues", "## Code Quality Issues", and include a section for "## Solutions" to address the identified issues with clear code examples. Highlight the most pressing issues using **bold text**. Ensure the response is well-structured, using markdown format with appropriate section headings.

        \`\`\`solidity
        ${sourceCode}
        \`\`\`

        Here is Slither's Analysis:
                
        \`\`\`
        ${slitherResult}
        \`\`\`
        `;

        const response = await openai.chat.completions.create({
            model: "gpt-4-0613",
            messages: [
                { role: "system", content: "You are an assistant that helps analyze Solidity smart contracts." },
                { role: "user", content: promptContent },
            ],
        });

        const analysis = response.choices[0].message.content;

        console.log("FULL ANALYSIS: " + analysis);

        // Save the analysis to a temporary file in the public directory
        fs.writeFileSync(path.join(__dirname, 'public', 'analysis.json'), JSON.stringify({
            analysis
        }), 'utf8');

        // Respond with a success message
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
