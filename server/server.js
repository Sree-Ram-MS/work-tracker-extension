// Daily Work Tracker — local SMTP relay
//
// Browsers cannot open raw SMTP sockets, so the extension calls this tiny
// server instead, and this server does the actual SMTP send with Nodemailer.
//
// Run it locally:
//   cd server
//   npm install
//   npm start
//
// Then in the extension's Dashboard > Email Settings, set Relay URL to:
//   http://localhost:5055/send
//
// Nothing is stored on this server — each request carries its own SMTP
// credentials and is used once to send that one email.

const express = require("express");
const cors = require("cors");
const nodemailer = require("nodemailer");

const PORT = process.env.PORT || 5055;
const app = express();

app.use(cors());
app.use(express.json({ limit: "2mb" }));

app.post("/send", async (req, res) => {
  const { to, subject, html, smtp } = req.body || {};

  if (!to || !subject || !html) {
    return res.status(400).json({ error: "Missing 'to', 'subject' or 'html' in request body." });
  }
  if (!smtp || !smtp.host || !smtp.user || !smtp.appPassword) {
    return res.status(400).json({ error: "Missing SMTP host, user or appPassword." });
  }

  try {
    const transporter = nodemailer.createTransport({
      host: smtp.host,
      port: Number(smtp.port) || 587,
      secure: !!smtp.secure, // true for 465, false for 587 (STARTTLS)
      auth: {
        user: smtp.user,
        pass: smtp.appPassword
      }
    });

    await transporter.sendMail({
      from: smtp.user,
      to,
      subject,
      html
    });

    res.json({ ok: true });
  } catch (err) {
    console.error("Send failed:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/health", (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Work Tracker mail relay listening on http://localhost:${PORT}`);
});
