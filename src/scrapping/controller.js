import { chromium } from "playwright";
import { PDFParse } from "pdf-parse";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const downloadsDir = path.join(__dirname, "../../downloads");
if (!fs.existsSync(downloadsDir)) {
  fs.mkdirSync(downloadsDir, { recursive: true });
}

// ─────────────────────────────────────────────────────────────────────────────
// UTILITY: DOWNLOAD
//
// Fetches a file via Playwright's download event API (handles
// Content-Disposition: attachment responses that cause goto() to throw).
//
// Returns a Buffer — does NOT touch the filesystem.
// Callers decide what to do with the bytes (save, parse, both, neither).
//
// To remove: delete this function and all calls to downloadToBuffer().
// Nothing else is affected.
// ─────────────────────────────────────────────────────────────────────────────
async function downloadToBuffer(context, fullUrl) {
  const dlPage = await context.newPage();
  try {
    const [download] = await Promise.all([
      dlPage.waitForEvent("download", { timeout: 30000 }),
      dlPage.goto(fullUrl, { timeout: 30000 }).catch(() => {
        // goto() throws "Download is starting" when the server sends
        // Content-Disposition: attachment — expected, safe to ignore.
      })
    ]);

    const stream = await download.createReadStream();
    const chunks = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);

    if (buffer.length === 0) {
      throw new Error("Downloaded file is empty (0 bytes)");
    }

    return buffer;
  } finally {
    await dlPage.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// UTILITY: FILESYSTEM SAVE
//
// Writes a Buffer to disk under downloads/complaint_<id>/<fileName>.
// Completely independent — receives a buffer, knows nothing about how
// it was obtained or what it contains.
//
// To remove: delete this function and all calls to saveBufferToDisk().
// PDF parsing and everything else will still work.
// ─────────────────────────────────────────────────────────────────────────────
function saveBufferToDisk(buffer, complaintId, fileName) {
  const fileDir = path.join(downloadsDir, `complaint_${complaintId}`);
  if (!fs.existsSync(fileDir)) {
    fs.mkdirSync(fileDir, { recursive: true });
  }
  const filePath = path.join(fileDir, fileName);
  fs.writeFileSync(filePath, buffer);
  return filePath;
}

// ─────────────────────────────────────────────────────────────────────────────
// UTILITY: PDF PARSING
//
// Parses text from a Buffer — does NOT read from disk, does NOT know
// where the buffer came from.
//
// To remove: delete this function and all calls to parsePdfBuffer().
// File download and filesystem save will still work.
// ─────────────────────────────────────────────────────────────────────────────
async function parsePdfBuffer(buffer) {
  const parser = new PDFParse({ data: buffer });
  await parser.load();
  const result = await parser.getText();
  await parser.destroy();
  return result.text?.trim() || "";
}

// ─────────────────────────────────────────────────────────────────────────────
// CORE: PROCESS A SINGLE ATTACHMENT
//
// Orchestrates the three utilities above for one file.
// Each step is wrapped independently — a failure in save or parse
// does not affect the other.
//
// Dependency map:
//   downloadToBuffer  ──► buffer ──► saveBufferToDisk  (independent)
//                                └── parsePdfBuffer    (independent)
// ─────────────────────────────────────────────────────────────────────────────
async function processAttachment(context, { fileName, href, complaintId, currentPageUrl }) {
  const fileType = path.extname(fileName).toLowerCase();

  const fullUrl = href.startsWith("http")
    ? href
    : new URL(href, currentPageUrl).href;

  const result = {
    fileName,
    fileType,
    url: fullUrl,
    status: "failed",
    localPath: null,
    size: null,
    saveError: null,
    parsedText: null,
    parseError: null
  };

  // Step 1: Download to buffer — shared source for all consumers below
  let buffer;
  try {
    console.log(`  → Downloading: ${fileName}`);
    buffer = await downloadToBuffer(context, fullUrl);
    result.status = "downloaded";
    result.size = buffer.length;
    console.log(`  ✓ Downloaded ${buffer.length} bytes`);
  } catch (err) {
    result.status = "failed";
    result.saveError = err.message;
    console.error(`  ✗ Download failed: ${err.message}`);
    return result;
  }

  // Step 2: Save to filesystem — independent consumer of the buffer
  // Remove this block to disable disk saving. Parsing below still works.
  try {
    result.localPath = saveBufferToDisk(buffer, complaintId, fileName);
    console.log(`  ✓ Saved to disk: ${result.localPath}`);
  } catch (err) {
    result.saveError = err.message;
    console.error(`  ✗ Disk save failed: ${err.message}`);
  }

  // Step 3: Parse PDF text — independent consumer of the same buffer
  // Remove this block to disable PDF parsing. Disk save above still works.
  if (fileType === ".pdf") {
    try {
      console.log(`  → Parsing PDF text: ${fileName}`);
      result.parsedText = await parsePdfBuffer(buffer);
      console.log(`  ✓ Parsed ${result.parsedText.length} characters`);
    } catch (err) {
      result.parseError = err.message;
      console.error(`  ✗ PDF parse failed: ${err.message}`);
    }
  }

  return result;
}

export async function extract(req, res) {
  // const payload = Array.isArray(req.body) ? req.body[0] : req.body;
  // const { extractedUrl: url, extractedCode: code } = payload;

  const wrappedPayload = Array.isArray(req.body) ? req.body[0] : req.body;
// Support both old format and new nested format
  const payload = wrappedPayload.payload || wrappedPayload;
  const { extractedUrl: url, extractedCode: code } = payload;

  if (!url || !code) {
    return res.status(400).json({
      success: false,
      error: "Missing extractedUrl or extractedCode"
    });
  }

  let browser;

  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ acceptDownloads: true });
    const page = await context.newPage();

    // ──────────────────────────────────────────
    // STEP 1: AUTHENTICATE
    // ──────────────────────────────────────────
    console.log("Navigating to:", url);
    await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });
    await page.waitForTimeout(2000);

    const codeInputSelectors = [
      'input[name="code"]',
      'input[type="text"]',
      'input[placeholder*="code" i]',
      "#code"
    ];

    let codeInput = null;
    for (const selector of codeInputSelectors) {
      codeInput = await page.$(selector);
      if (codeInput) {
        await codeInput.fill(code);
        console.log("Code entered successfully");
        break;
      }
    }
    if (!codeInput) throw new Error("Access code input field not found");

    const submitButtonSelectors = [
      'button[type="submit"]',
      'button:has-text("Submit")',
      'button:has-text("Continue")',
      'input[type="submit"]'
    ];

    let submitted = false;
    for (const selector of submitButtonSelectors) {
      const btn = await page.$(selector);
      if (btn) {
        await btn.click();
        submitted = true;
        break;
      }
    }
    if (!submitted) throw new Error("Submit button not found");

    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(3000);

    // ──────────────────────────────────────────
    // STEP 2: EXTRACT COMPLAINT INFO
    // ──────────────────────────────────────────
    const complaintInfo = await page.evaluate(() => {
      const getFieldValue = (labelText) => {
        const labels = Array.from(document.querySelectorAll("label"));
        const label = labels.find(
          (l) =>
            l.innerText?.trim() === labelText ||
            l.innerText?.trim().startsWith(labelText)
        );
        if (label) {
          const parent = label.closest(".form-group");
          if (parent) {
            const value = parent.querySelector("div:not(.form-group)");
            return value ? value.innerText?.trim() : null;
          }
        }
        return null;
      };

      let complaintId = null;
      const navbarBrand = document.querySelector("a#hm");
      if (navbarBrand) {
        const match = navbarBrand.innerText?.match(/\d{6,}/);
        if (match) complaintId = match[0];
      }
      if (!complaintId) {
        const raw = getFieldValue("Complaint ID:");
        if (raw) {
          const match = raw.match(/\d{6,}/);
          complaintId = match ? match[0] : raw;
        }
      }

      return {
        complaintId,
        dateFiled: getFieldValue("Date Filed:"),
        complaintType: getFieldValue("Complaint Type:"),
        consumerName: getFieldValue("Name:"),
        consumerEmail: getFieldValue("Email:"),
        consumerPhone: getFieldValue("Daytime Phone:"),
        businessName: getFieldValue("Business Name:"),
        businessAddress: getFieldValue("Address:"),
        complaintDescription:
          document.querySelector("div#cmpld .card-body div.mb-3")?.innerText?.trim() || null,
        desiredSettlement:
          document.querySelector("div#cmpld .alert-light")?.innerText?.trim() || null
      };
    });

    console.log("Extracted complaintId:", complaintInfo.complaintId);
    const safeComplaintId = complaintInfo.complaintId || "unknown";

    // ──────────────────────────────────────────
    // STEP 2B: COLLECT & PROCESS ATTACHMENTS
    // ──────────────────────────────────────────
    const downloadedFiles = [];
    const currentPageUrl = page.url();
    console.log("Current page URL:", currentPageUrl);

    let mediaFiles = [];
    try {
      const allLinks = await page.$$eval("a[href*='LibAttachment']", (links) =>
        links
          .filter((link) => link.getAttribute("href")?.includes("LibAttachment"))
          .map((link) => ({
            fileName:
              link.innerText?.trim() ||
              link.getAttribute("title") ||
              "unknown_file",
            href: link.getAttribute("href"),
            complaintId: new URLSearchParams(
              link.getAttribute("href").split("?")[1] || ""
            ).get("ComplaintID")
          }))
          .filter((item) => item.fileName && item.href)
      );

      const seen = new Set();
      mediaFiles = allLinks.filter((f) => {
        if (seen.has(f.fileName)) return false;
        seen.add(f.fileName);
        return true;
      });

      console.log(`✓ Found ${mediaFiles.length} unique attachment(s) on page`);
    } catch (err) {
      console.log("✗ No attachment links found:", err.message);
    }

    for (const mediaFile of mediaFiles) {
      console.log(`\nProcessing attachment: ${mediaFile.fileName}`);
      const fileResult = await processAttachment(context, {
        fileName: mediaFile.fileName,
        href: mediaFile.href,
        complaintId: mediaFile.complaintId || safeComplaintId,
        currentPageUrl
      });
      downloadedFiles.push(fileResult);
    }

    // ──────────────────────────────────────────
    // STEP 3: EXTRACT MESSAGES & THEIR ATTACHMENTS
    // ──────────────────────────────────────────
    const messagesData = [];
    const documentsData = [];

    const messageRows = await page.$$("table.rgMasterTable tbody tr");
    console.log(`\nFound ${messageRows.length} message rows`);

    for (let i = 0; i < messageRows.length; i++) {
      try {
        const cells = await messageRows[i].$$("td");
        if (cells.length < 4) continue;

        const subject = await cells[3].evaluate((el) => el.innerText?.trim());
        const dateSent = await cells[4]?.evaluate((el) => el.innerText?.trim());
        console.log(`\nProcessing message ${i + 1}: ${subject}`);

        await messageRows[i].click();
        await page.waitForTimeout(2500);

        const msgData = await page.evaluate(() => {
          const from = document.querySelector("span#cp1_mv1_lblFrom")?.innerText?.trim();
          const toElements = document.querySelectorAll(".fld");
          const to = toElements.length > 1 ? toElements[1].innerText?.trim() : null;
          const sent = document.querySelector("span#cp1_mv1_lblSent")?.innerText?.trim();
          const sectionToPrint = document.querySelector("#section-to-print");
          const fullContent = sectionToPrint ? sectionToPrint.innerText?.trim() : null;

          let consumerMessage = null;
          let bbsMessage = null;
          if (fullContent) {
            const marker = "MESSAGE FROM CONSUMER:";
            if (fullContent.includes(marker)) {
              const parts = fullContent.split(marker);
              bbsMessage = parts[0].trim();
              consumerMessage = parts[1].trim();
            } else {
              bbsMessage = fullContent;
            }
          }
          return { from, to, sent, fullContent, bbsMessage, consumerMessage };
        });

        let attachmentLinks = [];
        try {
          attachmentLinks = await page.$$eval("a[href*='LibAttachment']", (links) =>
            links
              .map((link) => ({
                fileName: link.innerText?.trim(),
                href: link.getAttribute("href")
              }))
              .filter((l) => l.fileName && l.href)
          );
        } catch (e) {
          console.log("  No attachments in this message");
        }

        for (const link of attachmentLinks) {
          if (!documentsData.some((d) => d.fileName === link.fileName)) {
            documentsData.push({
              fileName: link.fileName,
              url: link.href,
              complaintId: safeComplaintId
            });
          }

          if (downloadedFiles.some((d) => d.fileName === link.fileName)) {
            console.log(`  Skipping already-processed: ${link.fileName}`);
            continue;
          }

          console.log(`\nProcessing message attachment: ${link.fileName}`);
          const fileResult = await processAttachment(context, {
            fileName: link.fileName,
            href: link.href,
            complaintId: safeComplaintId,
            currentPageUrl: page.url()
          });
          downloadedFiles.push(fileResult);
        }

        messagesData.push({
          index: i + 1,
          subject,
          dateSent,
          from: msgData.from,
          to: msgData.to,
          sent: msgData.sent,
          messageType: subject?.toLowerCase().includes("consumer")
            ? "consumer_comment"
            : "bbb_message",
          bbsMessage: msgData.bbsMessage,
          consumerMessage: msgData.consumerMessage,
          fullContent: msgData.fullContent,
          attachments: attachmentLinks
        });

        await page.goBack({ waitUntil: "networkidle" });
        await page.waitForTimeout(2000);

        const updatedRows = await page.$$("table.rgMasterTable tbody tr");
        if (updatedRows.length > 0) {
          messageRows.splice(0, messageRows.length, ...updatedRows);
        }
      } catch (error) {
        console.error(`Error processing message ${i + 1}:`, error.message);
      }
    }

    // ──────────────────────────────────────────
    // STEP 4: RETURN RESULTS
    // ──────────────────────────────────────────
    return res.json({
      success: true,
      extractedAt: new Date().toISOString(),
      complaint: complaintInfo,
      messages: messagesData,
      documents: documentsData,
      downloadedFiles,
      summary: {
        totalMessages: messagesData.length,
        totalDocuments: documentsData.length,
        totalFilesDownloaded: downloadedFiles.filter((f) => f.status === "downloaded").length,
        downloadLocation: path.join(downloadsDir, `complaint_${safeComplaintId}`)
      }
    });
  } catch (err) {
    console.error("Extraction error:", err);
    return res.status(500).json({
      success: false,
      error: err.message,
      details: err.stack
    });
  } finally {
    if (browser) await browser.close();
  }
}
