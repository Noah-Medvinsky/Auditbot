const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');
const OpenAI = require('openai');
const toml = require('toml');
const { runAll } = require('./contractAnalyzer');
const { generatePDF } = require('./generate-pdf');

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

        const detailedAnalysis = await getDetailedAnalysisFromGPT(combinedSourceCode, slitherResults);

        if (!detailedAnalysis) {
            return res.status(500).json({ error: 'Failed to get analysis from GPT.' });
        }

        const combinedContent = await getCombinedContentFromGPT(contractAddress, detailedAnalysis);

        const reportData = {
            summary: combinedContent.summary,
            scope: combinedContent.scope,
            securityIssues: detailedAnalysis.securityIssues,
            codeQualityIssues: detailedAnalysis.codeQualityIssues,
            solutions: detailedAnalysis.solutions,
            ratingsAndComments: combinedContent.ratingsAndComments,
            totalScore: combinedContent.totalScore
        };

        fs.writeFileSync(path.join(__dirname, 'public', 'analysis.json'), JSON.stringify(reportData), 'utf8');

        res.json({ success: true, ...reportData });
    } catch (error) {
        console.error("Error:", error);
        if (!res.headersSent) {
            res.status(500).json({ error: 'Something went wrong!' });
        }
    }
});

app.get('/download-pdf', (req, res) => {
    const analysisPath = path.join(__dirname, 'public', 'analysis.json');
    if (!fs.existsSync(analysisPath)) {
        return res.status(404).json({ error: 'Analysis not found!' });
    }

    const reportData = JSON.parse(fs.readFileSync(analysisPath, 'utf8'));

    generatePDF(reportData).then(() => {
        const filePath = path.join(__dirname, 'analysis-report.pdf');
        res.download(filePath, 'analysis-report.pdf', (err) => {
            if (err) {
                console.error('Error downloading PDF:', err);
                res.status(500).send('Error downloading PDF');
            }
        });
    }).catch(error => {
        console.error('Error generating PDF:', error);
        res.status(500).send('Error generating PDF');
    });
});

app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});

async function getDetailedAnalysisFromGPT(sourceCode, slitherResults) {
    const promptContent = `
You are a smart contract auditor. Analyze the following Solidity code for vulnerabilities such as overflow/underflow, reentrancy, and timestamp dependency. Provide detailed explanations for each identified vulnerability, categorize the issues into "## Security Issues", "## Code Quality Issues", and include a section for "## Solutions" to address the identified issues with clear code examples. Highlight the most pressing issues using **bold text**. Ensure the response is well-structured, using markdown format with appropriate section headings.

For each identified issue, provide an in-depth explanation of:
1. Why it is an issue
2. The potential impact of the issue
3. How the issue can be exploited
4. Any historical examples of similar issues
5. How the issue can be mitigated

Here is the contract code:
\`\`\`solidity
${sourceCode}
\`\`\`

Here is Slither's Analysis:
                
\`\`\`
${slitherResults}
\`\`\`
`;

    try {
        const response = await openai.chat.completions.create({
            model: "gpt-4-turbo",
            messages: [
                { role: "system", content: "You are an assistant that helps analyze Solidity smart contracts." },
                { role: "user", content: promptContent },
            ],
        });

        const analysis = response.choices[0].message.content;
        console.log("Detailed GPT Analysis:", analysis);

        const securityIssuesMatch = analysis.match(/## Security Issues([\s\S]*?)(?=## Code Quality Issues|## Solutions|$)/);
        const codeQualityIssuesMatch = analysis.match(/## Code Quality Issues([\s\S]*?)(?=## Security Issues|## Solutions|$)/);
        const solutionsMatch = analysis.match(/## Solutions([\s\S]*?)(?=## Security Issues|## Code Quality Issues|$)/);

        const securityIssues = securityIssuesMatch ? securityIssuesMatch[1].trim() : "No security issues found.";
        const codeQualityIssues = codeQualityIssuesMatch ? codeQualityIssuesMatch[1].trim() : "No code quality issues found.";
        const solutions = solutionsMatch ? solutionsMatch[1].trim() : "No solutions found.";

        return { securityIssues, codeQualityIssues, solutions, analysis };
    } catch (error) {
        console.error("GPT Error:", error);
        return null;
    }
}

async function getCombinedContentFromGPT(contractAddress, detailedAnalysis) {
    const promptContent = `
You are a smart contract auditor. Based on the following detailed analysis of a Solidity smart contract, provide a brief summary of the findings, the scope of the audit, and ratings for code quality and security. Additionally, provide a total score with detailed explanations for each score given.

Contract Address: ${contractAddress}

Here is the detailed analysis:
\`\`\`
${detailedAnalysis.analysis}
\`\`\`

Please provide the content in the following format:

### Summary
[Summary content]

### Scope
[Scope content]

### Code Quality
[Comments explaining why the score was given]
The total Code Quality score is [score] out of 10.

### Security
[Comments explaining why the score was given]
The security score is [score] out of 10.

### Total Score
Considering all metrics, the total score of the report is [total_score] out of 10.
`;

    try {
        const response = await openai.chat.completions.create({
            model: "gpt-4-turbo",
            messages: [
                { role: "system", content: "You are an assistant that helps analyze Solidity smart contracts." },
                { role: "user", content: promptContent },
            ],
        });

        const content = response.choices[0].message.content;
        console.log("Combined GPT Content:", content);

        const summaryMatch = content.match(/### Summary([\s\S]*?)### Scope/);
        const scopeMatch = content.match(/### Scope([\s\S]*?)### Code Quality/);
        const ratingsAndCommentsMatch = content.match(/### Code Quality([\s\S]*?)### Total Score/);
        const totalScoreMatch = content.match(/### Total Score([\s\S]*)/);

        const summary = summaryMatch ? summaryMatch[1].trim() : "No summary found.";
        const scope = scopeMatch ? scopeMatch[1].trim() : "No scope found.";
        const ratingsAndComments = ratingsAndCommentsMatch ? ratingsAndCommentsMatch[1].trim() : "No ratings and comments found.";
        const totalScore = totalScoreMatch ? totalScoreMatch[1].trim() : "No total score found.";

        return { summary, scope, ratingsAndComments, totalScore };
    } catch (error) {
        console.error("GPT Error:", error);
        return null;
    }
}

app.post('/analyze', async (req, res) => {
    const contractAddress = req.body.address;

    try {
        const { slitherResults, combinedSourceCode } = await runAll(contractAddress);

        if (!slitherResults || !combinedSourceCode) {
            return res.status(500).json({ error: 'Failed to analyze the contract.' });
        }

        const detailedAnalysis = await getDetailedAnalysisFromGPT(combinedSourceCode, slitherResults);

        if (!detailedAnalysis) {
            return res.status(500).json({ error: 'Failed to get analysis from GPT.' });
        }

        const combinedContent = await getCombinedContentFromGPT(contractAddress, detailedAnalysis);

        const reportData = {
            summary: combinedContent.summary,
            scope: combinedContent.scope,
            securityIssues: detailedAnalysis.securityIssues,
            codeQualityIssues: detailedAnalysis.codeQualityIssues,
            solutions: detailedAnalysis.solutions,
            ratingsAndComments: combinedContent.ratingsAndComments,
            totalScore: combinedContent.totalScore
        };

        fs.writeFileSync(path.join(__dirname, 'public', 'analysis.json'), JSON.stringify(reportData), 'utf8');

        res.json({ success: true, ...reportData });
    } catch (error) {
        console.error("Error:", error);
        if (!res.headersSent) {
            res.status(500).json({ error: 'Something went wrong!' });
        }
    }
});
