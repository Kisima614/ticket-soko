
const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const cors = require("cors");
const admin = require("firebase-admin");
const fs = require("fs");
const QRCode = require("qrcode");
const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");

const app = express();
const PORT = process.env.PORT || 10000;

const EVENT = "Bayern vs Ajax";
const EVENT_DATE = "5 January 2027";
const EVENT_TIME = "4:00 PM EAT";
const EVENT_VENUE = "Raila Odinga International Stadium, Nairobi";

// CORRECT PRIMARY WEBSITE
const FRONTEND_URL = "https://www.talantasportscitytickets.com/";

const PAYSTACK_URL = "https://api.paystack.co";
const PAYHERO_URL = "https://backend.payhero.co.ke";
const RESEND_URL = "https://api.resend.com/emails";

const RESERVATION_MINUTES = 15;
const MAX_QUANTITY = 20;
const SEATS_PER_SECTION = 60;

const TICKET_TYPES = {
  Regular: { price: 2500, capacity: 50000, color: [0.75, 0.18, 0.20] },
  VIP: { price: 5000, capacity: 15000, color: [0.10, 0.35, 0.75] },
  VVIP: { price: 15000, capacity: 5000, color: [0.38, 0.20, 0.65] },
  "VVIP PREMIUM": { price: 75000, capacity: 100, color: [0.70, 0.48, 0.10] }
};

const LEVEL_SECTIONS = {
  1: { first: 101, last: 128 },
  2: { first: 201, last: 220 },
  3: { first: 401, last: 435 }
};

// FIREBASE INITIALIZATION

const SERVICE_ACCOUNT_PATH =
  process.env.GOOGLE_APPLICATION_CREDENTIALS ||
  "/etc/secrets/serviceAccountKey.json";

if (!admin.apps.length) {
  if (!fs.existsSync(SERVICE_ACCOUNT_PATH)) {
    throw new Error("Firebase service account file not found.");
  }

  const serviceAccount = require(SERVICE_ACCOUNT_PATH);

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

const db = admin.firestore();
const Timestamp = admin.firestore.Timestamp;

// CORRECTED CORS CONFIGURATION

const ALLOWED_ORIGINS = new Set([
  "https://talantasportscitytickets.com",
  "https://www.talantasportscitytickets.com",
  "http://talantasportscitytickets.com",
  "http://www.talantasportscitytickets.com",

  // Secondary website
  "https://talantacity.com",
  "https://www.talantacity.com",

  // Development
  "https://kisima614.github.io",
  "http://localhost:3000"
]);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || ALLOWED_ORIGINS.has(origin)) {
      return callback(null, true);
    }

    console.log("CORS blocked origin:", origin);
    return callback(new Error("Origin not allowed by CORS"));
  },

  methods: ["GET", "POST", "OPTIONS"],

  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "x-ticket-scanner-key"
  ],

  optionsSuccessStatus: 204
}));

app.use(express.json({
  limit: "1mb",
  verify: (req, res, buffer) => {
    req.rawBody = Buffer.from(buffer);
  }
}));

// AUTHENTICATION HELPERS

function paymentHeaders() {
  if (!process.env.PAYSTACK_SECRET_KEY) {
    throw new Error("Paystack secret key is missing.");
  }

  return {
    Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
    "Content-Type": "application/json"
  };
}

function payheroHeaders() {
  let token = process.env.PAYHERO_BASIC_AUTH_TOKEN;

  if (!token) {
    const username = process.env.PAYHERO_API_USERNAME;
    const password = process.env.PAYHERO_API_PASSWORD;

    if (!username || !password) {
      throw new Error("PayHero API credentials are missing.");
    }

    token = Buffer.from(`${username}:${password}`).toString("base64");
  }

  token = token.replace(/^Basic\s+/i, "").trim();

  return {
    Authorization: `Basic ${token}`,
    "Content-Type": "application/json"
  };
}

// GENERAL HELPERS

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}

function money(value) {
  return Number(value).toLocaleString("en-KE");
}

function bookingReference() {
  return "TSC-" + crypto.randomUUID();
}

function ticketNumber() {
  return "TSC-" +
    crypto.randomUUID().replace(/-/g, "").slice(0, 12).toUpperCase();
}

function normalizePhone(phone) {
  const value = String(phone || "").replace(/[\s-]/g, "");

  if (/^07\d{8}$/.test(value) || /^01\d{8}$/.test(value)) {
    return "+254" + value.slice(1);
  }

  if (/^\+254[17]\d{8}$/.test(value)) {
    return value;
  }

  if (/^254[17]\d{8}$/.test(value)) {
    return "+" + value;
  }

  throw new Error("Enter a valid Kenyan mobile number.");
}

function validReference(reference) {
  return /^TSC-[a-f0-9-]{36}$/i.test(reference);
}

function seatDocument(seatId) {
  return db.collection("stadiumSeats").doc(seatId);
}

function ticketColor(ticketType) {
  const values = TICKET_TYPES[ticketType]?.color || [0.05, 0.12, 0.25];

  return rgb(values[0], values[1], values[2]);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function safeCompare(a, b) {
  if (typeof a !== "string" || typeof b !== "string") {
    return false;
  }

  const first = Buffer.from(a);
  const second = Buffer.from(b);

  return first.length === second.length &&
    crypto.timingSafeEqual(first, second);
}

// VALIDATE STADIUM SEATS

function validateSeats(level, section, seats, quantity) {
  const levelInfo = LEVEL_SECTIONS[level];

  if (!levelInfo) {
    throw new Error("Please select a valid stadium level.");
  }

  if (
    !Number.isInteger(section) ||
    section < levelInfo.first ||
    section > levelInfo.last
  ) {
    throw new Error("The selected section does not belong to this level.");
  }

  if (
    !Array.isArray(seats) ||
    seats.length !== quantity ||
    seats.some(seat =>
      !Number.isInteger(seat) ||
      seat < 1 ||
      seat > SEATS_PER_SECTION
    ) ||
    new Set(seats).size !== seats.length
  ) {
    throw new Error("Select the exact number of valid, different seats.");
  }

  return seats.map(seat => ({
    number: seat,
    id: `L${level}-S${section}-N${String(seat).padStart(2, "0")}`
  }));
}

// CREATE INDIVIDUAL TICKET RECORDS

function prepareTicketRecords(booking) {
  return booking.seats.map(seat => {
    const id = crypto.randomUUID();
    const token = crypto.randomBytes(32).toString("hex");

    return {
      id,
      token,
      tokenHash: sha256(token),
      ticketNumber: ticketNumber(),
      event: EVENT,
      eventDate: EVENT_DATE,
      eventTime: EVENT_TIME,
      venue: EVENT_VENUE,
      bookingReference: booking.reference,
      customerName: booking.customerName,
      customerEmail: booking.email,
      ticketType: booking.ticketType,
      amount: booking.unitPrice,
      currency: "KES",
      level: booking.level,
      section: booking.section,
      seatNumber: seat.number,
      seatId: seat.id,
      status: "valid",
      createdAt: Timestamp.now()
    };
  });
}

// PDF TICKET GENERATION

async function createTicketPDF(ticket) {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([600, 300]);

  const regularFont = await pdf.embedFont(StandardFonts.Helvetica);
  const boldFont = await pdf.embedFont(StandardFonts.HelveticaBold);

  const mainColor = ticketColor(ticket.ticketType);

  page.drawRectangle({
    x: 0,
    y: 0,
    width: 600,
    height: 300,
    color: rgb(0.035, 0.055, 0.10)
  });

  page.drawRectangle({
    x: 0,
    y: 240,
    width: 600,
    height: 60,
    color: mainColor
  });

  page.drawRectangle({
    x: 445,
    y: 0,
    width: 155,
    height: 240,
    color: rgb(0.08, 0.11, 0.17)
  });

  page.drawText("TALANTA SPORT CITY", {
    x: 25,
    y: 265,
    size: 20,
    font: boldFont,
    color: rgb(1, 1, 1)
  });

  page.drawText("OFFICIAL EVENT TICKET", {
    x: 25,
    y: 248,
    size: 9,
    font: regularFont,
    color: rgb(1, 1, 1)
  });

  page.drawText(ticket.event, {
    x: 25,
    y: 213,
    size: 22,
    font: boldFont,
    color: rgb(1, 1, 1)
  });

  page.drawText(`${ticket.eventDate}  |  ${ticket.eventTime}`, {
    x: 25,
    y: 188,
    size: 11,
    font: regularFont,
    color: rgb(0.85, 0.88, 0.93)
  });

  page.drawText(ticket.venue, {
    x: 25,
    y: 170,
    size: 9,
    font: regularFont,
    color: rgb(0.85, 0.88, 0.93)
  });

  page.drawText("TICKET HOLDER", {
    x: 25,
    y: 140,
    size: 8,
    font: boldFont,
    color: rgb(0.65, 0.72, 0.82)
  });

  page.drawText(String(ticket.customerName).slice(0, 45), {
    x: 25,
    y: 124,
    size: 13,
    font: boldFont,
    color: rgb(1, 1, 1)
  });

  page.drawText("CATEGORY", {
    x: 25,
    y: 96,
    size: 8,
    font: boldFont,
    color: rgb(0.65, 0.72, 0.82)
  });

  page.drawText(ticket.ticketType, {
    x: 25,
    y: 80,
    size: 13,
    font: boldFont,
    color: rgb(1, 1, 1)
  });

  page.drawText(
    `LEVEL ${ticket.level}  |  SECTION ${ticket.section}  |  SEAT ${ticket.seatNumber}`,
    {
      x: 25,
      y: 54,
      size: 10,
      font: boldFont,
      color: rgb(1, 1, 1)
    }
  );

  page.drawText(`KSh ${money(ticket.amount)}`, {
    x: 25,
    y: 30,
    size: 11,
    font: boldFont,
    color: rgb(0.95, 0.82, 0.40)
  });

  page.drawText("TICKET STUB", {
    x: 462,
    y: 215,
    size: 10,
    font: boldFont,
    color: rgb(1, 1, 1)
  });

  page.drawText(ticket.ticketNumber, {
    x: 462,
    y: 195,
    size: 9,
    font: boldFont,
    color: rgb(0.95, 0.82, 0.40)
  });

  const qrContent = `${ticket.id}.${ticket.token}`;

  const qrBuffer = await QRCode.toBuffer(qrContent, {
    type: "png",
    errorCorrectionLevel: "H",
    width: 220,
    margin: 1
  });

  const qrImage = await pdf.embedPng(qrBuffer);

  page.drawImage(qrImage, {
    x: 465,
    y: 65,
    width: 105,
    height: 105
  });

  page.drawText("SCAN AT ENTRY", {
    x: 473,
    y: 48,
    size: 8,
    font: boldFont,
    color: rgb(1, 1, 1)
  });

  page.drawText("One ticket per seat", {
    x: 465,
    y: 28,
    size: 7,
    font: regularFont,
    color: rgb(0.75, 0.78, 0.84)
  });

  return Buffer.from(await pdf.save());
}

// RESEND EMAIL HELPER

async function sendResendEmail({ to, subject, html, attachments }) {
  if (!process.env.RESEND_API_KEY) {
    throw new Error("RESEND_API_KEY is missing.");
  }

  if (!process.env.EMAIL_FROM) {
    throw new Error("EMAIL_FROM is missing.");
  }

  const response = await axios.post(
    RESEND_URL,
    {
      from: process.env.EMAIL_FROM,
      to: Array.isArray(to) ? to : [to],
      subject,
      html,
      attachments: attachments || []
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json"
      },
      timeout: 30000
    }
  );

  return response.data;
}

// EMAIL CUSTOMER AND ADMIN AFTER PAYMENT

async function sendBookingNotifications(reference) {
  const bookingRef = db.collection("bookings").doc(reference);
  const snap = await bookingRef.get();

  if (!snap.exists) return;

  const booking = snap.data();

  if (booking.status !== "paid") return;
  if (booking.emailNotificationStatus === "sent") return;

  const claim = await db.runTransaction(async tx => {
    const currentSnap = await tx.get(bookingRef);

    if (!currentSnap.exists) return false;

    const current = currentSnap.data();

    if (
      current.status !== "paid" ||
      current.emailNotificationStatus === "sent" ||
      current.emailNotificationStatus === "sending"
    ) {
      return false;
    }

    tx.update(bookingRef, {
      emailNotificationStatus: "sending",
      emailNotificationStartedAt: Timestamp.now()
    });

    return true;
  });

  if (!claim) return;

  try {
    const ticketSnapshots = await db.collection("tickets")
      .where("bookingReference", "==", reference)
      .get();

    const tickets = ticketSnapshots.docs.map(doc => ({
      ...doc.data(),
      id: doc.id
    }));

    if (tickets.length !== booking.quantity) {
      throw new Error("The individual tickets are not ready.");
    }

    const attachments = [];

    for (const ticket of tickets) {
      const pdfBuffer = await createTicketPDF(ticket);

      attachments.push({
        filename: `${ticket.ticketNumber}.pdf`,
        content: pdfBuffer.toString("base64"),
        content_type: "application/pdf"
      });
    }

    const ticketRows = tickets.map(ticket => `
      <tr>
        <td>${escapeHTML(ticket.ticketNumber)}</td>
        <td>${escapeHTML(ticket.ticketType)}</td>
        <td>${escapeHTML(ticket.section)}</td>
        <td>${escapeHTML(ticket.seatNumber)}</td>
      </tr>
    `).join("");

    const customerHtml = `
      <div style="font-family:Arial,sans-serif;color:#172033;max-width:650px;margin:auto">
        <div style="background:#101a30;color:white;padding:25px;text-align:center">
          <h1>TALANTA SPORT CITY</h1>
          <h2>Payment Successful</h2>
        </div>
        <div style="padding:25px">
          <p>Hello ${escapeHTML(booking.customerName)},</p>
          <p>Your payment has been confirmed. Your individual PDF tickets are attached to this email.</p>
          <h3>${escapeHTML(EVENT)}</h3>
          <p>${escapeHTML(EVENT_DATE)} | ${escapeHTML(EVENT_TIME)}</p>
          <p>${escapeHTML(EVENT_VENUE)}</p>
          <p><strong>Booking reference:</strong> ${escapeHTML(reference)}</p>
          <p><strong>Payment reference:</strong> ${escapeHTML(booking.paymentReference)}</p>
          <p><strong>Amount paid:</strong> KSh ${money(booking.amount)}</p>
          <table style="width:100%;border-collapse:collapse" border="1" cellpadding="9">
            <thead>
              <tr>
                <th>Ticket number</th>
                <th>Category</th>
                <th>Section</th>
                <th>Seat</th>
              </tr>
            </thead>
            <tbody>${ticketRows}</tbody>
          </table>
          <p>Each seat has its own ticket and QR code. Present the corresponding ticket at the stadium entrance.</p>
          <p>Thank you for booking with Talanta Sport City.</p>
          <p><a href="${FRONTEND_URL}">Visit Talanta Sport City</a></p>
        </div>
      </div>
    `;

    await sendResendEmail({
      to: booking.email,
      subject: `Your ${EVENT} tickets - ${reference}`,
      html: customerHtml,
      attachments
    });

    const adminHtml = `
      <div style="font-family:Arial,sans-serif">
        <h2>New Paid Booking - Talanta Sport City</h2>
        <p><strong>Customer:</strong> ${escapeHTML(booking.customerName)}</p>
        <p><strong>Email:</strong> ${escapeHTML(booking.email)}</p>
        <p><strong>Phone:</strong> ${escapeHTML(booking.phone)}</p>
        <p><strong>Booking reference:</strong> ${escapeHTML(reference)}</p>
        <p><strong>Payment method:</strong> ${escapeHTML(booking.paymentMethod)}</p>
        <p><strong>Payment reference:</strong> ${escapeHTML(booking.paymentReference)}</p>
        <p><strong>Category:</strong> ${escapeHTML(booking.ticketType)}</p>
        <p><strong>Quantity:</strong> ${booking.quantity}</p>
        <p><strong>Level:</strong> ${booking.level}</p>
        <p><strong>Section:</strong> ${booking.section}</p>
        <p><strong>Amount:</strong> KSh ${money(booking.amount)}</p>
        <p><strong>Seats:</strong> ${booking.seats.map(s => escapeHTML(s.number)).join(", ")}</p>
        <p><strong>Event:</strong> ${escapeHTML(EVENT)}</p>
      </div>
    `;

    if (process.env.ADMIN_EMAIL) {
      await sendResendEmail({
        to: process.env.ADMIN_EMAIL,
        subject: `Paid booking received - ${reference}`,
        html: adminHtml,
        attachments
      });
    }

    await bookingRef.update({
      emailNotificationStatus: "sent",
      emailNotificationSentAt: Timestamp.now(),
      emailNotificationError: admin.firestore.FieldValue.delete()
    });

    console.log("Ticket emails sent:", reference);

  } catch (error) {
    console.error("Ticket email error:", error.response?.data || error.message);

    await bookingRef.update({
      emailNotificationStatus: "failed",
      emailNotificationError: String(
        error.response?.data?.message || error.message
      ).slice(0, 500),
      emailNotificationFailedAt: Timestamp.now()
    }).catch(updateError => {
      console.error("Could not update email status:", updateError.message);
    });
  }
}

// RELEASE ONE EXPIRED BOOKING

async function releaseBooking(reference) {
  const bookingRef = db.collection("bookings").doc(reference);

  await db.runTransaction(async tx => {
    const bookingSnap = await tx.get(bookingRef);

    if (!bookingSnap.exists) return;

    const booking = bookingSnap.data();

    if (booking.status !== "pending") return;

    const counterRef = db.collection("inventory").doc(booking.ticketType);
    const counterSnap = await tx.get(counterRef);
    const counter = counterSnap.exists ? counterSnap.data() : {};

    const seatRefs = (booking.seats || []).map(seat =>
      seatDocument(seat.id)
    );

    const seatSnaps = [];

    for (const ref of seatRefs) {
      seatSnaps.push(await tx.get(ref));
    }

    tx.set(counterRef, {
      sold: counter.sold || 0,
      held: Math.max(0, (counter.held || 0) - booking.quantity)
    });

    seatSnaps.forEach((snap, index) => {
      if (
        snap.exists &&
        snap.data().reference === reference &&
        snap.data().status === "pending"
      ) {
        tx.delete(seatRefs[index]);
      }
    });

    tx.update(bookingRef, {
      status: "expired",
      paymentStatus: "expired",
      expiredAt: Timestamp.now()
    });
  });
}

// RELEASE EXPIRED RESERVATIONS

async function releaseExpiredReservations() {
  const now = Timestamp.now();

  const expired = await db.collection("bookings")
    .where("status", "==", "pending")
    .where("expiresAt", "<=", now)
    .limit(50)
    .get();

  for (const doc of expired.docs) {
    await releaseBooking(doc.id);
  }
}

// CREATE EXACT SEAT RESERVATION

async function createReservation(details) {
  const {
    reference,
    name,
    email,
    phone,
    quantity,
    ticketType,
    level,
    section,
    seats,
    paymentMethod
  } = details;

  const type = TICKET_TYPES[ticketType];
  const bookingRef = db.collection("bookings").doc(reference);
  const counterRef = db.collection("inventory").doc(ticketType);

  return db.runTransaction(async tx => {
    const bookingSnap = await tx.get(bookingRef);

    if (bookingSnap.exists) {
      throw new Error("Booking reference already exists.");
    }

    const counterSnap = await tx.get(counterRef);

    const counter = counterSnap.exists
      ? counterSnap.data()
      : { sold: 0, held: 0 };

    if (
      (counter.sold || 0) +
      (counter.held || 0) +
      quantity > type.capacity
    ) {
      throw new Error("This ticket category has insufficient availability.");
    }

    const seatRefs = seats.map(seat => seatDocument(seat.id));
    const seatSnaps = [];

    for (const ref of seatRefs) {
      seatSnaps.push(await tx.get(ref));
    }

    for (const snap of seatSnaps) {
      if (snap.exists) {
        const existing = snap.data();

        if (
          existing.status === "paid" ||
          (
            existing.status === "pending" &&
            existing.expiresAt &&
            existing.expiresAt.toMillis() > Date.now()
          )
        ) {
          throw new Error(
            "One or more selected seats are already taken. Please choose different seats."
          );
        }
      }
    }

    const expiresAt = Timestamp.fromDate(
      new Date(Date.now() + RESERVATION_MINUTES * 60 * 1000)
    );

    tx.set(counterRef, {
      sold: counter.sold || 0,
      held: (counter.held || 0) + quantity
    });

    seats.forEach((seat, index) => {
      tx.set(seatRefs[index], {
        seatId: seat.id,
        level,
        section,
        seatNumber: seat.number,
        ticketType,
        reference,
        status: "pending",
        expiresAt,
        createdAt: Timestamp.now()
      });
    });

    tx.create(bookingRef, {
      reference,
      event: EVENT,
      customerName: name,
      email,
      phone,
      ticketType,
      unitPrice: type.price,
      quantity,
      amount: type.price * quantity,
      currency: "KES",
      level,
      section,
      seats,
      status: "pending",
      paymentStatus: "pending",
      paymentMethod,
      emailNotificationStatus: "not_sent",
      createdAt: Timestamp.now(),
      expiresAt
    });

    return { seats, expiresAt };
  });
}

// FINALIZE VERIFIED PAYMENT AND CREATE INDIVIDUAL TICKETS

async function finalizeBooking(reference, paymentReference) {
  const bookingRef = db.collection("bookings").doc(reference);

  const initialSnap = await bookingRef.get();

  if (!initialSnap.exists) {
    throw new Error("Booking record not found.");
  }

  const initialBooking = initialSnap.data();

  if (initialBooking.status === "paid") {
    return initialBooking;
  }

  const preparedTickets = prepareTicketRecords(initialBooking);

  return db.runTransaction(async tx => {
    const bookingSnap = await tx.get(bookingRef);

    if (!bookingSnap.exists) {
      throw new Error("Booking record not found.");
    }

    const booking = bookingSnap.data();

    if (booking.status === "paid") return booking;

    if (booking.status !== "pending") {
      throw new Error("Booking is no longer pending.");
    }

    const counterRef = db.collection("inventory").doc(booking.ticketType);
    const counterSnap = await tx.get(counterRef);
    const counter = counterSnap.exists ? counterSnap.data() : {};

    const seatRefs = (booking.seats || []).map(seat =>
      seatDocument(seat.id)
    );

    const seatSnaps = [];

    for (const ref of seatRefs) {
      seatSnaps.push(await tx.get(ref));
    }

    for (const snap of seatSnaps) {
      if (
        !snap.exists ||
        snap.data().reference !== reference ||
        snap.data().status !== "pending"
      ) {
        throw new Error("One or more seat reservations are no longer valid.");
      }
    }

    const ticketRefs = preparedTickets.map(ticket =>
      db.collection("tickets").doc(ticket.id)
    );

    for (const ticketRef of ticketRefs) {
      const existing = await tx.get(ticketRef);

      if (existing.exists) {
        throw new Error("Ticket ID collision. Please retry payment verification.");
      }
    }

    const now = Timestamp.now();

    tx.set(counterRef, {
      sold: (counter.sold || 0) + booking.quantity,
      held: Math.max(0, (counter.held || 0) - booking.quantity)
    });

    seatSnaps.forEach((snap, index) => {
      tx.update(seatRefs[index], {
        status: "paid",
        paidAt: now,
        paymentReference
      });
    });

    preparedTickets.forEach((ticket, index) => {
      tx.create(ticketRefs[index], {
        ...ticket,
        paidAt: now
      });
    });

    const confirmed = {
      ...booking,
      status: "paid",
      paymentStatus: "success",
      ticketNumber: preparedTickets[0].ticketNumber,
      ticketNumbers: preparedTickets.map(t => t.ticketNumber),
      ticketIds: preparedTickets.map(t => t.id),
      paymentReference,
      paidAt: now
    };

    tx.set(bookingRef, confirmed);

    return confirmed;
  });
}

// VERIFY PAYSTACK CARD PAYMENT

async function confirmCardPayment(reference) {
  const bookingSnap = await db.collection("bookings").doc(reference).get();

  if (!bookingSnap.exists) {
    throw new Error("Booking record not found.");
  }

  const booking = bookingSnap.data();

  if (booking.status === "paid") {
    await sendBookingNotifications(reference);
    return booking;
  }

  if (
    booking.paymentMethod !== "card" ||
    booking.paymentProvider !== "paystack"
  ) {
    throw new Error("This is not a Paystack card payment.");
  }

  const response = await axios.get(
    `${PAYSTACK_URL}/transaction/verify/${encodeURIComponent(reference)}`,
    {
      headers: paymentHeaders(),
      timeout: 20000
    }
  );

  const payment = response.data.data;

  if (
    response.data.status !== true ||
    payment.status !== "success" ||
    payment.reference !== reference ||
    payment.currency !== "KES" ||
    Number(payment.amount) !== booking.amount * 100
  ) {
    throw new Error("Paystack card payment verification failed.");
  }

  const confirmed = await finalizeBooking(reference, reference);

  await sendBookingNotifications(reference);

  return confirmed;
}

// VERIFY PAYHERO M-PESA PAYMENT

async function confirmMpesaPayment(reference) {
  const bookingRef = db.collection("bookings").doc(reference);
  const bookingSnap = await bookingRef.get();

  if (!bookingSnap.exists) {
    throw new Error("M-Pesa booking not found.");
  }

  const booking = bookingSnap.data();

  if (booking.status === "paid") {
    await sendBookingNotifications(reference);
    return booking;
  }

  if (
    booking.paymentMethod !== "mobile_money" ||
    booking.paymentProvider !== "payhero" ||
    !booking.payheroReference
  ) {
    throw new Error("PayHero payment reference not found.");
  }

  const response = await axios.get(
    `${PAYHERO_URL}/api/v2/transaction-status`,
    {
      params: { reference: booking.payheroReference },
      headers: payheroHeaders(),
      timeout: 20000
    }
  );

  const payment = response.data;

  if (
    payment.success !== true ||
    String(payment.status).toUpperCase() !== "SUCCESS" ||
    payment.provider !== "m-pesa" ||
    payment.reference !== booking.payheroReference
  ) {
    throw new Error("PayHero has not confirmed this M-Pesa payment.");
  }

  const confirmed = await finalizeBooking(
    reference,
    payment.provider_reference ||
    payment.third_party_reference ||
    booking.payheroReference
  );

  await sendBookingNotifications(reference);

  return confirmed;
}

// HOME / SERVER HEALTH CHECK

app.get("/", (req, res) => {
  res.json({
    service: "Talanta Sport City",
    status: "running",
    website: FRONTEND_URL,
    event: EVENT,
    eventDate: EVENT_DATE,
    eventTime: EVENT_TIME,
    venue: EVENT_VENUE,
    capacity: 70000,
    categories: TICKET_TYPES,
    currency: "KES",
    paymentMethods: ["PayHero M-Pesa", "Paystack Card"],
    manualSeatSelection: true,
    seatsPerSection: SEATS_PER_SECTION,
    individualPdfTickets: true,
    qrVerification: true
  });
});

// OPTIMIZED SEAT AVAILABILITY

app.get("/api/seats/:level/:section", async (req, res) => {
  const startedAt = Date.now();

  try {
    const level = Number(req.params.level);
    const section = Number(req.params.section);
    const levelInfo = LEVEL_SECTIONS[level];

    if (
      !levelInfo ||
      !Number.isInteger(section) ||
      section < levelInfo.first ||
      section > levelInfo.last
    ) {
      return res.status(400).json({
        status: false,
        message: "Invalid level or section."
      });
    }

    res.set("Cache-Control", "no-store");

    const seatRefs = Array.from(
      { length: SEATS_PER_SECTION },
      (_, index) => {
        const number = index + 1;

        const id =
          `L${level}-S${section}-N${String(number).padStart(2, "0")}`;

        return seatDocument(id);
      }
    );

    const snapshots = await db.getAll(...seatRefs);
    const now = Date.now();

    const seats = snapshots.map((snap, index) => {
      const number = index + 1;
      let status = "available";

      if (snap.exists) {
        const data = snap.data();

        if (data.status === "paid") {
          status = "sold";
        } else if (
          data.status === "pending" &&
          data.expiresAt &&
          data.expiresAt.toMillis() > now
        ) {
          status = "reserved";
        }
      }

      return {
        number,
        id: seatRefs[index].id,
        status
      };
    });

    console.log(
      `Seat loading: L${level} S${section} | ${Date.now() - startedAt}ms`
    );

    return res.json({
      status: true,
      level,
      section,
      seats
    });

  } catch (error) {
    console.error("Seat availability error:", error);

    return res.status(500).json({
      status: false,
      message: "Unable to retrieve seats. Please try again."
    });
  }
});

// TICKET AVAILABILITY

app.get("/api/tickets/availability", async (req, res) => {
  try {
    await releaseExpiredReservations();

    const result = {};

    const snapshots = await Promise.all(
      Object.keys(TICKET_TYPES).map(name =>
        db.collection("inventory").doc(name).get()
      )
    );

    Object.entries(TICKET_TYPES).forEach(([name, type], index) => {
      const snap = snapshots[index];

      const data = snap.exists
        ? snap.data()
        : { sold: 0, held: 0 };

      result[name] = {
        capacity: type.capacity,
        sold: data.sold || 0,
        reserved: data.held || 0,
        available: Math.max(
          0,
          type.capacity - (data.sold || 0) - (data.held || 0)
        ),
        price: type.price
      };
    });

    res.json({
      status: true,
      availability: result
    });

  } catch (error) {
    console.error("Availability error:", error.message);

    res.status(500).json({
      status: false,
      message: "Unable to retrieve ticket availability."
    });
  }
});

// INITIALIZE PAYMENT

app.post("/api/payments/initialize", async (req, res) => {
  let reference;
  let reservationCreated = false;
  let chargeAccepted = false;

  try {
    const {
      name,
      email,
      phone,
      quantity,
      ticket_type,
      payment_method,
      stadium_level,
      section,
      selected_seats
    } = req.body;

    const ticketType = String(ticket_type || "");
    const type = TICKET_TYPES[ticketType];
    const method = String(payment_method || "").toLowerCase();

    if (!type) {
      throw new Error("Invalid ticket category.");
    }

    if (
      typeof name !== "string" ||
      !name.trim() ||
      name.length > 100 ||
      typeof email !== "string" ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
      typeof phone !== "string" ||
      phone.length > 20
    ) {
      throw new Error("Please enter valid customer details.");
    }

    const mobileNumber = normalizePhone(phone);

    if (
      !Number.isInteger(quantity) ||
      quantity < 1 ||
      quantity > MAX_QUANTITY
    ) {
      throw new Error(`Choose between 1 and ${MAX_QUANTITY} tickets.`);
    }

    const level = Number(stadium_level);
    const selectedSection = Number(section);

    const seats = validateSeats(
      level,
      selectedSection,
      selected_seats,
      quantity
    );

    const isCard = ["card", "bank_card"].includes(method);

    const isMobile = [
      "mobile_money",
      "mpesa",
      "m-pesa"
    ].includes(method);

    if (!isCard && !isMobile) {
      throw new Error("Choose M-Pesa or bank card.");
    }

    if (isCard && !process.env.PAYSTACK_SECRET_KEY) {
      throw new Error("Paystack is not configured.");
    }

    if (isMobile && !process.env.PAYHERO_CHANNEL_ID) {
      throw new Error("PayHero channel ID is missing.");
    }

    if (isMobile) {
      payheroHeaders();
    }

    await releaseExpiredReservations();

    reference = bookingReference();

    await createReservation({
      reference,
      name: name.trim(),
      email: email.trim(),
      phone: mobileNumber,
      quantity,
      ticketType,
      paymentMethod: isCard ? "card" : "mobile_money",
      level,
      section: selectedSection,
      seats
    });

    reservationCreated = true;

    const amount = type.price * quantity;

    // PAYSTACK CARD PAYMENT

    if (isCard) {
      const callback =
        process.env.CALLBACK_URL ||
        "https://talanta-sport-city-backend.onrender.com/api/payments/verify";

      const response = await axios.post(
        `${PAYSTACK_URL}/transaction/initialize`,
        {
          email: email.trim(),
          amount: amount * 100,
          currency: "KES",
          reference,
          callback_url: callback,
          channels: ["card"],
          metadata: {
            event: EVENT,
            booking_reference: reference,
            customer_name: name.trim(),
            phone: mobileNumber,
            quantity,
            ticket_type: ticketType,
            unit_price: type.price,
            stadium_level: level,
            section: selectedSection,
            selected_seats: seats.map(seat => seat.number)
          }
        },
        {
          headers: paymentHeaders(),
          timeout: 20000
        }
      );

      if (
        response.data.status !== true ||
        !response.data.data.authorization_url
      ) {
        throw new Error("Paystack card initialization failed.");
      }

      chargeAccepted = true;

      await db.collection("bookings").doc(reference).update({
        paymentProvider: "paystack",
        paymentInitiatedAt: Timestamp.now()
      });

      return res.json({
        status: true,
        provider: "paystack",
        payment_method: "card",
        authorization_url: response.data.data.authorization_url,
        reference,
        amount,
        currency: "KES"
      });
    }

    // PAYHERO M-PESA STK PUSH

    const channelId = Number(process.env.PAYHERO_CHANNEL_ID);

    if (!Number.isInteger(channelId) || channelId <= 0) {
      throw new Error("Invalid PayHero channel ID.");
    }

    const callbackUrl =
      process.env.PAYHERO_CALLBACK_URL ||
      "https://talanta-sport-city-backend.onrender.com/api/payments/payhero-callback";

    const response = await axios.post(
      `${PAYHERO_URL}/api/v2/payments`,
      {
        amount,
        phone_number: mobileNumber,
        channel_id: channelId,
        provider: "m-pesa",
        external_reference: reference,
        customer_name: name.trim(),
        callback_url: callbackUrl
      },
      {
        headers: payheroHeaders(),
        timeout: 30000
      }
    );

    const payment = response.data;

    if (payment.success !== true || !payment.reference) {
      throw new Error(
        payment.message || "PayHero could not initiate M-Pesa."
      );
    }

    chargeAccepted = true;

    await db.collection("bookings").doc(reference).update({
      paymentProvider: "payhero",
      payheroReference: payment.reference,
      payheroCheckoutRequestID: payment.CheckoutRequestID || null,
      paymentInitiatedAt: Timestamp.now(),
      payheroStatus: payment.status || "QUEUED"
    });

    return res.json({
      status: true,
      provider: "payhero",
      payment_method: "mobile_money",
      message: "Check your phone and enter your M-Pesa PIN.",
      reference,
      amount,
      currency: "KES"
    });

  } catch (error) {
    console.error(
      "Payment initialization error:",
      error.response?.data || error.message
    );

    if (reference && reservationCreated && !chargeAccepted) {
      try {
        await releaseBooking(reference);
      } catch (releaseError) {
        console.error(
          "Reservation release error:",
          releaseError.message
        );
      }
    }

    return res.status(400).json({
      status: false,
      message:
        error.response?.data?.message ||
        error.response?.data?.data?.message ||
        error.message ||
        "Unable to start payment.",
      reference: chargeAccepted ? reference : undefined
    });
  }
});

// PAYSTACK CARD RETURN / VERIFICATION

app.get("/api/payments/verify", async (req, res) => {
  try {
    const reference = String(req.query.reference || "");

    if (!validReference(reference)) {
      return res.status(400).send("Invalid booking reference.");
    }

    const booking = await confirmCardPayment(reference);

    const seats = (booking.seats || [])
      .map(seat =>
        `Section ${booking.section}, Seat ${seat.number}`
      )
      .map(escapeHTML)
      .join("<br>");

    res.send(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta name="viewport" content="width=device-width,initial-scale=1">
        <title>Payment Successful | Talanta Sport City</title>
        <style>
          body {
            font-family:Arial,sans-serif;
            background:#10172b;
            color:white;
            text-align:center;
            padding:25px 12px;
          }
          .card {
            background:white;
            color:#172033;
            max-width:430px;
            margin:20px auto;
            padding:25px;
            border-radius:13px;
          }
          h1 {color:#13884b}
          .ref {
            background:#eef2f8;
            padding:13px;
            overflow-wrap:anywhere;
          }
          a {
            display:inline-block;
            background:#13884b;
            color:white;
            padding:13px 22px;
            text-decoration:none;
            border-radius:6px;
            margin-top:15px;
          }
        </style>
      </head>
      <body>
        <div class="card">
          <h1>✓ Payment Successful!</h1>
          <h2>TALANTA SPORT CITY</h2>
          <h3>${escapeHTML(EVENT)}</h3>
          <p>${escapeHTML(EVENT_VENUE)}</p>
          <hr>
          <p>Customer: ${escapeHTML(booking.customerName)}</p>
          <p>Ticket category: ${escapeHTML(booking.ticketType)}</p>
          <p>Level: ${booking.level}</p>
          <p>Section: ${booking.section}</p>
          <p>Tickets: ${booking.quantity}</p>
          <p>Seats:<br>${seats}</p>
          <h2>KSh ${money(booking.amount)}</h2>
          <p>Booking reference:</p>
          <div class="ref">
            <strong>${escapeHTML(reference)}</strong>
          </div>
          <p>Your individual PDF tickets have been sent to your email address.</p>
          <a href="${escapeHTML(FRONTEND_URL)}">Return to website</a>
        </div>
      </body>
      </html>
    `);

  } catch (error) {
    console.error(
      "Paystack verification error:",
      error.response?.data || error.message
    );

    res.status(400).send(`
      <h2>Payment not confirmed</h2>
      <p>${escapeHTML(error.message)}</p>
      <p>If you have paid, contact Talanta Sport City before paying again.</p>
      <a href="${escapeHTML(FRONTEND_URL)}">Return to website</a>
    `);
  }
});

// CHECK PAYMENT STATUS

app.get("/api/payments/status/:reference", async (req, res) => {
  try {
    const reference = String(req.params.reference || "");

    if (!validReference(reference)) {
      return res.status(400).json({
        status: false,
        message: "Invalid booking reference."
      });
    }

    const bookingRef = db.collection("bookings").doc(reference);
    const snap = await bookingRef.get();

    if (!snap.exists) {
      return res.status(404).json({
        status: false,
        message: "Booking not found."
      });
    }

    let booking = snap.data();

    if (
      booking.status === "pending" &&
      booking.paymentMethod === "mobile_money" &&
      booking.paymentProvider === "payhero" &&
      booking.payheroReference
    ) {
      try {
        await confirmMpesaPayment(reference);

        const refreshed = await bookingRef.get();
        booking = refreshed.data();

      } catch (error) {
        console.log("PayHero M-Pesa status check:", error.message);
      }

    } else if (
      booking.status === "paid" &&
      booking.emailNotificationStatus !== "sent"
    ) {
      await sendBookingNotifications(reference);

      const refreshed = await bookingRef.get();
      booking = refreshed.data();
    }

    return res.json({
      status: true,
      paymentStatus: booking.paymentStatus,
      bookingStatus: booking.status,
      ticketNumber: booking.ticketNumber || null,
      ticketNumbers: booking.ticketNumbers || [],
      ticketCount: booking.ticketIds?.length || 0,
      emailNotificationStatus: booking.emailNotificationStatus || "not_sent",
      paymentMethod: booking.paymentMethod,
      paymentProvider: booking.paymentProvider || null
    });

  } catch (error) {
    console.error("Payment status error:", error.message);

    res.status(500).json({
      status: false,
      message: "Unable to check payment status."
    });
  }
});

// PAYHERO PAYMENT CALLBACK

app.post("/api/payments/payhero-callback", async (req, res) => {
  try {
    const callback = req.body.response || req.body;
    const reference = String(callback.ExternalReference || "");

    if (!validReference(reference)) {
      return res.sendStatus(400);
    }

    const bookingRef = db.collection("bookings").doc(reference);
    const snap = await bookingRef.get();

    if (!snap.exists) return res.sendStatus(404);

    const booking = snap.data();

    if (
      booking.paymentProvider !== "payhero" ||
      booking.paymentMethod !== "mobile_money"
    ) {
      return res.sendStatus(400);
    }

    if (booking.status === "paid") {
      await sendBookingNotifications(reference);
      return res.sendStatus(200);
    }

    const callbackStatus = String(callback.Status || "").toLowerCase();
    const resultCode = Number(callback.ResultCode);
    const callbackAmount = Number(callback.Amount);

    if (
      callbackStatus !== "success" ||
      resultCode !== 0 ||
      callbackAmount !== booking.amount ||
      !callback.MpesaReceiptNumber
    ) {
      await bookingRef.update({
        payheroLastCallbackStatus: callback.Status || "Unknown",
        payheroLastCallbackDescription: callback.ResultDesc || null,
        payheroCallbackReceivedAt: Timestamp.now()
      });

      return res.sendStatus(200);
    }

    const confirmed = await confirmMpesaPayment(reference);

    if (confirmed.status !== "paid") {
      throw new Error("Payment could not be finalized.");
    }

    await bookingRef.update({
      mpesaReceiptNumber: String(callback.MpesaReceiptNumber),
      payheroCheckoutRequestID:
        callback.CheckoutRequestID ||
        booking.payheroCheckoutRequestID ||
        null,
      payheroConfirmedAt: Timestamp.now(),
      payheroLastCallbackStatus: "Success"
    });

    await sendBookingNotifications(reference);

    console.log("PayHero payment confirmed:", reference);

    return res.sendStatus(200);

  } catch (error) {
    console.error(
      "PayHero callback error:",
      error.response?.data || error.message
    );

    return res.sendStatus(500);
  }
});

// PAYSTACK WEBHOOK

app.post("/api/payments/webhook", async (req, res) => {
  try {
    const secret = process.env.PAYSTACK_SECRET_KEY;
    const signature = req.headers["x-paystack-signature"];

    if (!secret || !signature || !req.rawBody) {
      return res.sendStatus(401);
    }

    const expected = crypto
      .createHmac("sha512", secret)
      .update(req.rawBody)
      .digest();

    if (!/^[a-f0-9]{128}$/i.test(signature)) {
      return res.sendStatus(401);
    }

    const received = Buffer.from(signature, "hex");

    if (
      received.length !== expected.length ||
      !crypto.timingSafeEqual(expected, received)
    ) {
      return res.sendStatus(401);
    }

    if (req.body.event === "charge.success") {
      const paystackReference = req.body.data.reference;

      const bookingSnap = await db.collection("bookings")
        .doc(paystackReference)
        .get();

      if (
        bookingSnap.exists &&
        bookingSnap.data().paymentMethod === "card" &&
        bookingSnap.data().paymentProvider === "paystack"
      ) {
        await confirmCardPayment(paystackReference);

        console.log(
          "Paystack card payment confirmed:",
          paystackReference
        );
      }
    }

    return res.sendStatus(200);

  } catch (error) {
    console.error(
      "Paystack webhook error:",
      error.response?.data || error.message
    );

    return res.sendStatus(500);
  }
});

// SECURE TICKET VERIFICATION / SINGLE-USE ENTRY

app.post("/api/tickets/verify", async (req, res) => {
  try {
    const scannerKey = req.headers["x-ticket-scanner-key"];

    if (
      !process.env.TICKET_SCANNER_KEY ||
      !safeCompare(
        String(scannerKey || ""),
        process.env.TICKET_SCANNER_KEY
      )
    ) {
      return res.status(401).json({
        valid: false,
        message: "Unauthorized scanner."
      });
    }

    const qrValue = String(req.body.qr || "");
    const parts = qrValue.split(".");

    if (parts.length !== 2) {
      return res.status(400).json({
        valid: false,
        message: "Invalid ticket QR code."
      });
    }

    const [ticketId, token] = parts;

    if (
      !/^[a-f0-9-]{36}$/i.test(ticketId) ||
      !/^[a-f0-9]{64}$/i.test(token)
    ) {
      return res.status(400).json({
        valid: false,
        message: "Invalid ticket QR code."
      });
    }

    const ticketRef = db.collection("tickets").doc(ticketId);

    const result = await db.runTransaction(async tx => {
      const ticketSnap = await tx.get(ticketRef);

      if (!ticketSnap.exists) {
        return {
          valid: false,
          message: "Ticket not found."
        };
      }

      const ticket = ticketSnap.data();

      if (ticket.tokenHash !== sha256(token)) {
        return {
          valid: false,
          message: "Invalid ticket security code."
        };
      }

      if (ticket.status === "used") {
        return {
          valid: false,
          message: "Ticket has already been used.",
          ticketNumber: ticket.ticketNumber,
          usedAt: ticket.usedAt?.toDate?.()?.toISOString() || null
        };
      }

      if (ticket.status !== "valid") {
        return {
          valid: false,
          message: "Ticket is not valid."
        };
      }

      tx.update(ticketRef, {
        status: "used",
        usedAt: Timestamp.now()
      });

      return {
        valid: true,
        message: "ENTRY APPROVED",
        ticketNumber: ticket.ticketNumber,
        customerName: ticket.customerName,
        ticketType: ticket.ticketType,
        section: ticket.section,
        seatNumber: ticket.seatNumber,
        event: ticket.event
      };
    });

    return res.status(result.valid ? 200 : 409).json(result);

  } catch (error) {
    console.error("Ticket verification error:", error.message);

    return res.status(500).json({
      valid: false,
      message: "Unable to verify ticket."
    });
  }
});

// MANUAL EMAIL RETRY - PROTECTED

app.post("/api/admin/retry-ticket-email/:reference", async (req, res) => {
  try {
    const suppliedKey = String(req.headers.authorization || "")
      .replace(/^Bearer\s+/i, "");

    if (
      !process.env.TICKET_SCANNER_KEY ||
      !safeCompare(suppliedKey, process.env.TICKET_SCANNER_KEY)
    ) {
      return res.status(401).json({
        status: false,
        message: "Unauthorized."
      });
    }

    const reference = String(req.params.reference || "");

    if (!validReference(reference)) {
      return res.status(400).json({
        status: false,
        message: "Invalid booking reference."
      });
    }

    const bookingRef = db.collection("bookings").doc(reference);
    const snap = await bookingRef.get();

    if (!snap.exists || snap.data().status !== "paid") {
      return res.status(404).json({
        status: false,
        message: "Paid booking not found."
      });
    }

    if (snap.data().emailNotificationStatus === "sent") {
      return res.json({
        status: true,
        message: "Ticket email was already sent."
      });
    }

    await bookingRef.update({
      emailNotificationStatus: "failed"
    });

    await sendBookingNotifications(reference);

    const refreshed = await bookingRef.get();

    return res.json({
      status: true,
      emailNotificationStatus:
        refreshed.data().emailNotificationStatus || "unknown"
    });

  } catch (error) {
    console.error("Email retry error:", error.message);

    return res.status(500).json({
      status: false,
      message: "Unable to retry ticket email."
    });
  }
});

// SERVER START

app.listen(PORT, () => {
  console.log(`Talanta Sport City running on port ${PORT}`);
  console.log(`Primary website: ${FRONTEND_URL}`);
  console.log(`Event: ${EVENT}`);
  console.log(`Event date: ${EVENT_DATE}`);
  console.log(`Event time: ${EVENT_TIME}`);
});
