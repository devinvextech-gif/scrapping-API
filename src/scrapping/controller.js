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
// ─────────────────────────────────────────────────────────────────────────────
async function downloadToBuffer(context, fullUrl) {
  const dlPage = await context.newPage();
  try {
    const [download] = await Promise.all([
      dlPage.waitForEvent("download", { timeout: 30000 }),
      dlPage.goto(fullUrl, { timeout: 30000 }).catch(() => {
        // goto() throws "Download is starting" for attachment responses — expected.
      })
    ]);

    const stream = await download.createReadStream();
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const buffer = Buffer.concat(chunks);
    if (buffer.length === 0) throw new Error("Downloaded file is empty (0 bytes)");
    return buffer;
  } finally {
    await dlPage.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// UTILITY: FILESYSTEM SAVE
// ─────────────────────────────────────────────────────────────────────────────
function saveBufferToDisk(buffer, complaintId, fileName) {
  const fileDir = path.join(downloadsDir, `complaint_${complaintId}`);
  if (!fs.existsSync(fileDir)) fs.mkdirSync(fileDir, { recursive: true });
  const filePath = path.join(fileDir, fileName);
  fs.writeFileSync(filePath, buffer);
  return filePath;
}

// ─────────────────────────────────────────────────────────────────────────────
// UTILITY: PDF PARSING
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
// ─────────────────────────────────────────────────────────────────────────────
async function processAttachment(context, { fileName, href, complaintId, currentPageUrl }) {
  const fileType = path.extname(fileName).toLowerCase();
  const fullUrl = href.startsWith("http") ? href : new URL(href, currentPageUrl).href;

  const result = {
    fileName, fileType, url: fullUrl,
    status: "failed", localPath: null, size: null,
    saveError: null, parsedText: null, parseError: null
  };

  let buffer;
  try {
    console.log(`  → Downloading: ${fileName}`);
    buffer = await downloadToBuffer(context, fullUrl);
    result.status = "downloaded";
    result.size = buffer.length;
    console.log(`  ✓ Downloaded ${buffer.length} bytes`);
  } catch (err) {
    result.saveError = err.message;
    console.error(`  ✗ Download failed: ${err.message}`);
    return result;
  }

  try {
    result.localPath = saveBufferToDisk(buffer, complaintId, fileName);
    console.log(`  ✓ Saved to disk: ${result.localPath}`);
  } catch (err) {
    result.saveError = err.message;
    console.error(`  ✗ Disk save failed: ${err.message}`);
  }

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
  const wrappedPayload = Array.isArray(req.body) ? req.body[0] : req.body;
  const payload = wrappedPayload.payload || wrappedPayload;
  const { extractedUrl: url, extractedCode: code } = payload;

  if (!url || !code) {
    return res.status(400).json({ success: false, error: "Missing extractedUrl or extractedCode" });
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
          (l) => l.innerText?.trim() === labelText || l.innerText?.trim().startsWith(labelText)
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
    // STEP 2B: COLLECT & PROCESS INITIAL ATTACHMENTS
    // ──────────────────────────────────────────
    const downloadedFiles = [];
    const currentPageUrl = page.url();
    console.log("Current page URL:", currentPageUrl);

    let mediaFiles = [];
    try {
      const allLinks = await page.$$eval("a[href*='LibAttachment']", (links) =>
        links
          .map((link) => ({
            fileName: link.innerText?.trim() || link.getAttribute("title") || "unknown_file",
            href: link.getAttribute("href"),
            complaintId: new URLSearchParams(link.getAttribute("href").split("?")[1] || "").get("ComplaintID")
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
    // STEP 3: EXTRACT MESSAGES FROM MAIN PAGE TABLE
    //
    // Reads the messages grid already rendered on the main page:
    //   - message count (number of tbody rows)
    //   - subject, date, from/to actor (from icon title attributes)
    //   - MessageID (from Telerik _clientKeyValues JSON in inline script)
    //   - chk token (from hidden 6th column cell)
    //
    // Then opens each message URL in a separate page to read the full text.
    // NO modal is opened or clicked.
    // ──────────────────────────────────────────
    const messagesData = [];
    const documentsData = [];

    // ── 3a: Read table rows on the main page ─────────────────────────────────
    const messageMetadata = await page.evaluate(() => {
      // Extract MessageID map from the Telerik grid init script.
      // _clientKeyValues looks like: {"0":{"MessageID":"101518764"},"1":{"MessageID":"101402859"}}
      // We must match the full nested object — [^}]+ stops at the first }, so we use a
      // greedy match up to the closing double-brace instead.
      const messageIdMap = {};
      try {
        const scripts = Array.from(document.querySelectorAll("script"));
        for (const s of scripts) {
          // Match the full _clientKeyValues value: starts with { ends with }}
          const match = s.textContent.match(/"_clientKeyValues"\s*:\s*(\{(?:[^{}]|\{[^{}]*\})*\})/);
          if (match) {
            const parsed = JSON.parse(match[1]);
            for (const [rowIdx, obj] of Object.entries(parsed)) {
              if (obj.MessageID) messageIdMap[Number(rowIdx)] = String(obj.MessageID);
            }
            break;
          }
        }
      } catch (_) {}

      // Resolve actor name from the icon title in a cell
      const resolveActor = (cell) => {
        const icon = cell ? cell.querySelector("i[title]") : null;
        return icon ? icon.getAttribute("title") : "";
      };

      // Target specifically the messages grid table (not the attachments table)
      const rows = Array.from(
        document.querySelectorAll("#ctl00_cp1_msg_rg table.rgMasterTable tbody tr")
      );

      return rows.map((row, idx) => {
        const cells = row.querySelectorAll("td");
        if (cells.length < 5) return null;

        const from     = resolveActor(cells[1]); // icon title: "Business" or "BBB"
        const to       = resolveActor(cells[2]); // icon title: "BBB" or "Business"
        const subject  = cells[3]?.innerText?.trim() || "";
        const dateSent = cells[4]?.innerText?.trim() || "";
        // Column 5 (display:none) holds the chk token as raw text
        const chk      = cells[5]?.innerText?.trim() || "";

        const messageId = messageIdMap[idx] || row.getAttribute("id")?.split("__").pop() || "";

        return { index: idx + 1, from, to, subject, dateSent, chk, messageId };
      }).filter(Boolean);
    });

    console.log(`\nFound ${messageMetadata.length} message(s) in main page table`);

    // ── 3b: Fetch full text for each message via its direct URL ──────────────
    const pageOrigin = new URL(currentPageUrl).origin;

    for (const msgMeta of messageMetadata) {
      console.log(`\nMessage ${msgMeta.index}: "${msgMeta.subject}" (id=${msgMeta.messageId}, chk=${msgMeta.chk})`);

      let msgData = {
        sent: "",
        from: msgMeta.from,
        to: msgMeta.to,
        subject: msgMeta.subject,
        fullContent: "",
        bbsMessage: null,
        consumerMessage: null,
        attachments: []
      };

      if (msgMeta.messageId && msgMeta.chk) {
        // Message viewer URL pattern from the source HTML's viewMsg() function
        const messageUrl = `${pageOrigin}/complaints/message/?msg=${msgMeta.messageId}&chk=${msgMeta.chk}`;
        console.log(`  → Fetching: ${messageUrl}`);

        const msgPage = await context.newPage();
        try {
          await msgPage.goto(messageUrl, { waitUntil: "networkidle", timeout: 60000 });
          await msgPage.waitForTimeout(1000);
          await msgPage
            .waitForSelector(".msg, #section-to-print, span[id*='lblFrom']", { timeout: 10000 })
            .catch(() => {});

          const extracted = await msgPage.evaluate(() => {
            // Read labelled span fields
            const spanText = (idFragment) => {
              const el = document.querySelector(`span[id*="${idFragment}"]`);
              return el ? el.innerText?.trim() : "";
            };

            // Read .fld sibling of a .font-weight-bold label
            const fieldByLabel = (labelPartial) => {
              const rows = Array.from(document.querySelectorAll(".form-group.row"));
              for (const row of rows) {
                const label = row.querySelector(".font-weight-bold");
                if (label && label.innerText.includes(labelPartial)) {
                  const fld = row.querySelector(".fld");
                  return fld ? fld.innerText?.trim() : "";
                }
              }
              return "";
            };

            const sent    = spanText("lblSent");
            const from    = spanText("lblFrom") || fieldByLabel("From:");
            const to      = fieldByLabel("To:");
            const subject = spanText("lblSubject") || fieldByLabel("Subject:");

            // #section-to-print is visibility:hidden by default (only shown on @media print)
            // so innerText returns "". Use #trmsg which is always visible — it wraps the
            // "originally read on" alert + the actual letter content.
            // We want just the letter body, so skip the alert-dark banner at the top.
            let fullContent = "";
            const trmsg = document.querySelector("#trmsg");
            if (trmsg) {
              // Remove the "This message originally read on..." alert text
              const clone = trmsg.cloneNode(true);
              const alertBanner = clone.querySelector(".alert-dark");
              if (alertBanner) alertBanner.remove();
              fullContent = clone.innerText?.trim() || "";
            }
            if (!fullContent) {
              // Fallback: try .msg wrapper
              const msgDiv = document.querySelector(".msg");
              if (msgDiv) fullContent = msgDiv.innerText?.trim() || "";
            }

            // Split consumer statement from BBB letter body
            let bbsMessage = null;
            let consumerMessage = null;
            if (fullContent) {
              const marker = "Customer\u2019s Statement of the Problem:";
              const altMarker = "Customer's Statement of the Problem:";
              const markerIdx = fullContent.indexOf(marker) !== -1
                ? fullContent.indexOf(marker)
                : fullContent.indexOf(altMarker);

              if (markerIdx !== -1) {
                bbsMessage = fullContent.slice(0, markerIdx).trim();
                consumerMessage = fullContent.slice(markerIdx).trim();
              } else {
                bbsMessage = fullContent;
              }
            }

            return { sent, from, to, subject, fullContent, bbsMessage, consumerMessage };
          });

          console.log(`  ✓ from="${extracted.from}" to="${extracted.to}" content=${extracted.fullContent.length} chars`);

          // Collect attachments listed inside this message page
          let attachmentLinks = [];
          try {
            attachmentLinks = await msgPage.$$eval("a[href*='LibAttachment']", (links) =>
              links.map((link) => ({
                fileName: link.innerText?.trim(),
                href: link.getAttribute("href")
              })).filter((l) => l.fileName && l.href)
            );
          } catch (_) {}

          for (const link of attachmentLinks) {
            if (!documentsData.some((d) => d.fileName === link.fileName)) {
              documentsData.push({ fileName: link.fileName, url: link.href, complaintId: safeComplaintId });
            }
            if (!downloadedFiles.some((d) => d.fileName === link.fileName)) {
              console.log(`  Downloading message attachment: ${link.fileName}`);
              const fileResult = await processAttachment(context, {
                fileName: link.fileName,
                href: link.href,
                complaintId: safeComplaintId,
                currentPageUrl: messageUrl
              });
              downloadedFiles.push(fileResult);
            }
          }

          msgData = {
            sent:            extracted.sent,
            from:            extracted.from || msgMeta.from,
            to:              extracted.to   || msgMeta.to,
            subject:         extracted.subject || msgMeta.subject,
            fullContent:     extracted.fullContent,
            bbsMessage:      extracted.bbsMessage,
            consumerMessage: extracted.consumerMessage,
            attachments:     attachmentLinks
          };

        } catch (err) {
          console.error(`  ✗ Failed to fetch message page: ${err.message}`);
        } finally {
          await msgPage.close();
        }
      } else {
        console.log("  ⚠ Missing messageId or chk — skipping full content fetch");
      }

      // Determine message type from the "from" actor
      let messageType = "bbb_message";
      if (msgMeta.from === "Business") messageType = "business_response";
      else if (msgMeta.from === "Consumer") messageType = "consumer_comment";

      messagesData.push({
        index:           msgMeta.index,
        messageId:       msgMeta.messageId,
        subject:         msgData.subject,
        dateSent:        msgMeta.dateSent,
        sent:            msgData.sent,
        from:            msgData.from,
        to:              msgData.to,
        messageType,
        bbsMessage:      msgData.bbsMessage,
        consumerMessage: msgData.consumerMessage,
        fullContent:     msgData.fullContent,
        attachments:     msgData.attachments
      });
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
    return res.status(500).json({ success: false, error: err.message, details: err.stack });
  } finally {
    if (browser) await browser.close();
  }
}
