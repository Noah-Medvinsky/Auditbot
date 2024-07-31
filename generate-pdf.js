const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');
const marked = require('marked');

// Function to replace placeholders in the HTML template with actual content
function replacePlaceholders(template, placeholders) {
    return template.replace(/{{(.*?)}}/g, (_, key) => placeholders[key.trim()] || '');
}

async function generatePDF(reportData) {
    // Load the HTML template
    const templatePath = path.join(__dirname, 'template.html');
    const template = fs.readFileSync(templatePath, 'utf8');

    // Replace placeholders in the template
    const htmlContent = replacePlaceholders(template, {
        summary: marked.parse(reportData.summary),
        scope: marked.parse(reportData.scope),
        securityIssues: marked.parse(reportData.securityIssues),
        codeQualityIssues: marked.parse(reportData.codeQualityIssues),
        solutions: marked.parse(reportData.solutions),
        ratingsAndComments: marked.parse(reportData.ratingsAndComments),
        totalScore: marked.parse(reportData.totalScore)
    });

    // Log final HTML content for debugging
    console.log("Final HTML Content:", htmlContent);

    // Launch Puppeteer and generate the PDF
    const browser = await puppeteer.launch({
        executablePath: '/usr/bin/google-chrome-stable',
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--single-process',
            '--no-zygote',
            '--disable-gpu'
        ]
    });
    const page = await browser.newPage();
    await page.setContent(htmlContent, { waitUntil: 'networkidle0' });
    const pdfPath = path.join(__dirname, 'analysis-report.pdf');
    await page.pdf({
        path: pdfPath,
        format: 'A4',
        printBackground: true,
    });

    await browser.close();
    console.log(`PDF generated at: ${pdfPath}`);
}

module.exports = {
    generatePDF
};
