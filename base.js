// server.js

const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const OpenAI = require('openai');
const toml = require('toml');
const { runAll } = require('./contractAnalyzer'); // Import the runAll function

const app = express();
const port = 3000;

const secretsPath = path.join(__dirname, 'secrets.toml');
const secrets = toml.parse(fs.readFileSync(secretsPath, 'utf8'));

const openai = new OpenAI({
    apiKey: secrets.OPENAI,
});

app.use(bodyParser.json());
app.use(express.static('public'));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/results', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'results.html'));
});

app.post('/analyze', async (req, res) => {
    const contractAddress = req.body.address;

    try {
        const { slitherResults, combinedSourceCode } = await runAll(contractAddress);

        if (!slitherResults || !combinedSourceCode) {
            return res.status(500).json({ error: 'Failed to analyze the contract.' });
        }

        const promptContent = `
You are a smart contract auditor. Analyze the following Solidity code for vulnerabilities such as overflow/underflow, reentrancy, and timestamp dependency. Provide detailed explanations for each identified vulnerability, categorize the issues into "## Security Issues", "## Code Quality Issues", and include a section for "## Solutions" to address the identified issues with clear code examples. Highlight the most pressing issues using **bold text**. Ensure the response is well-structured, using markdown format with appropriate section headings.

Here is the contract code:
\`\`\`solidity
${combinedSourceCode}
\`\`\`

Here is Slither's Analysis:
                
\`\`\`
${slitherResults}
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

        res.json({ success: true, analysis });
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
