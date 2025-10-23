// src/App.js
import React, { useEffect, useMemo, useState, useRef } from "react";
import "bootstrap/dist/css/bootstrap.min.css";

/*
  Discharge Summary — Bootstrap UI version
  - UI layout matches the previous Bootstrap-based form style
  - Patient list fetched from /patients.json (public)
  - ABHA addresses normalized + dropdown (same behavior)
  - Practitioners come from global PRACTITIONERS constant
  - Build FHIR Bundle (document) with Composition + Patient + Practitioner + Encounter + MedicationRequests + DocumentReference + Binary
  - Bundle.identifier uses urn:ietf:rfc:3986 + urn:uuid:<uuid>
  - XHTML narratives include lang & xml:lang
  - File upload accepts .pdf, .jpg, .jpeg (base64 encoded); placeholder used when none uploaded
  - Only UI changed — logic preserved
*/

/* --------------------------- GLOBAL PRACTITIONERS --------------------------- */
const PRACTITIONERS = [
  {
    id: "prac-1",
    name: "Dr. A. Verma",
    qualification: "MBBS, MD (Medicine)",
    phone: "+91-90000-11111",
    email: "dr.verma@example.org",
    registration: { system: "https://nmc.org.in", value: "NMC-123456" },
  },
  {
    id: "prac-2",
    name: "Dr. B. Rao",
    qualification: "MBBS, MS (Surgery)",
    phone: "+91-90000-22222",
    email: "dr.rao@example.org",
    registration: { system: "https://nmc.org.in", value: "NMC-654321" },
  },
];

/* --------------------------------- HELPERS --------------------------------- */
function uuidv4() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function toFHIRDateFromDDMMYYYY(ddmmyyyy) {
  if (!ddmmyyyy) return undefined;
  const parts = String(ddmmyyyy).split("-");
  if (parts.length !== 3) return undefined;
  const [dd, mm, yyyy] = parts;
  if (yyyy && yyyy.length === 4) return `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
  return undefined;
}

function nowISOWithOffset() {
  const d = new Date();
  const tzo = -d.getTimezoneOffset();
  const sign = tzo >= 0 ? "+" : "-";
  const pad = n => String(Math.floor(Math.abs(n))).padStart(2, "0");
  return (
    d.getFullYear() +
    "-" +
    pad(d.getMonth() + 1) +
    "-" +
    pad(d.getDate()) +
    "T" +
    pad(d.getHours()) +
    ":" +
    pad(d.getMinutes()) +
    ":" +
    pad(d.getSeconds()) +
    sign +
    pad(tzo / 60) +
    ":" +
    pad(tzo % 60)
  );
}

/* Narrative wrapper with lang & xml:lang */
function buildNarrative(title, html) {
  return {
    status: "generated",
    div: `<div xmlns="http://www.w3.org/1999/xhtml" lang="en-IN" xml:lang="en-IN"><h3>${title}</h3>${html}</div>`,
  };
}

/* convert file to base64 (no data:... prefix) */
function fileToBase64NoPrefix(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("File read error"));
    reader.onload = () => {
      const result = reader.result || "";
      const idx = String(result).indexOf("base64,");
      if (idx >= 0) resolve(String(result).slice(idx + 7));
      else resolve(String(result));
    };
    reader.readAsDataURL(file);
  });
}

/* Small PDF placeholder */
const PLACEHOLDER_PDF_B64 = "JVBERi0xLjQKJeLjz9MK";

/* Fixed SNOMED codes/displays from mapping (must match exactly) */
const SNOMED = {
  DOC_TYPE: { system: "http://snomed.info/sct", code: "373942005", display: "Discharge summary" },

  SECTION_CHIEF: { system: "http://snomed.info/sct", code: "422843007", display: "Chief complaint section" },
  SECTION_PHYS: { system: "http://snomed.info/sct", code: "425044008", display: "Physical exam section" },
  SECTION_ALLERGY: { system: "http://snomed.info/sct", code: "722446000", display: "Allergy record" },
  SECTION_MEDHIST: { system: "http://snomed.info/sct", code: "1003642006", display: "Past medical history section" },
  SECTION_FAMHIST: { system: "http://snomed.info/sct", code: "422432008", display: "Family history section" },
  SECTION_INVEST: { system: "http://snomed.info/sct", code: "721981007", display: "Diagnostic studies report" },
  SECTION_MEDS: { system: "http://snomed.info/sct", code: "1003606003", display: "Medication history section" },
  SECTION_PROC: { system: "http://snomed.info/sct", code: "1003640003", display: "History of past procedure section" },
  SECTION_CAREPLAN: { system: "http://snomed.info/sct", code: "734163000", display: "Care plan" },
  SECTION_DOCREF: { system: "http://snomed.info/sct", code: "373942005", display: "Discharge summary" },
};

/* Dosage instruction standard */
function buildDosageInstructionStandard() {
  return [
    {
      text: "One tablet twice a day after meal",
      additionalInstruction: [
        { coding: [{ system: "http://snomed.info/sct", code: "311504000", display: "With or after food" }] },
      ],
      timing: { repeat: { frequency: 2, period: 1, periodUnit: "d" } },
      route: { coding: [{ system: "http://snomed.info/sct", code: "26643006", display: "Oral Route" }] },
      method: { coding: [{ system: "http://snomed.info/sct", code: "421521009", display: "Swallow" }] },
    },
  ];
}

/* Normalize ABHA addresses: handles strings or objects with 'address' & 'isPrimary' */
function normalizeAbhaAddresses(patientObj) {
  const raw =
    patientObj?.additional_attributes?.abha_addresses && Array.isArray(patientObj.additional_attributes.abha_addresses)
      ? patientObj.additional_attributes.abha_addresses
      : Array.isArray(patientObj?.abha_addresses)
      ? patientObj.abha_addresses
      : [];

  const out = raw
    .map((item) => {
      if (!item) return null;
      if (typeof item === "string") return { value: item, label: item, primary: false };
      if (typeof item === "object") {
        if (item.address) return { value: String(item.address), label: item.isPrimary ? `${item.address} (primary)` : String(item.address), primary: !!item.isPrimary };
        try {
          const v = JSON.stringify(item);
          return { value: v, label: v, primary: !!item.isPrimary };
        } catch { return null; }
      }
      return null;
    })
    .filter(Boolean);

  out.sort((a, b) => (b.primary - a.primary) || a.value.localeCompare(b.value));
  return out;
}

/* ------------------------------- APP COMPONENT ------------------------------ */
export default function App() {
  /* Patients (from public/patients.json) */
  const [patients, setPatients] = useState([]);
  const [selectedPatientIdx, setSelectedPatientIdx] = useState(-1);

  const selectedPatient = useMemo(() => (selectedPatientIdx >= 0 ? patients[selectedPatientIdx] : null), [patients, selectedPatientIdx]);

  const [abhaOptions, setAbhaOptions] = useState([]);
  const [selectedAbha, setSelectedAbha] = useState("");

  /* Practitioner (global) */
  const [selectedPractitionerIdx, setSelectedPractitionerIdx] = useState(0);

  /* Composition meta */
  const [docStatus, setDocStatus] = useState("final");
  const [docTitle, setDocTitle] = useState("Discharge Summary");

  /* Sections */
  const [chiefComplaints, setChiefComplaints] = useState("");
  const [physicalExam, setPhysicalExam] = useState("");
  const [allergiesText, setAllergiesText] = useState("");
  const [medicalHistoryText, setMedicalHistoryText] = useState("");
  const [familyHistoryText, setFamilyHistoryText] = useState("");
  const [investigationsText, setInvestigationsText] = useState("");
  const [carePlanText, setCarePlanText] = useState("");
  const [proceduresText, setProceduresText] = useState("");

  /* Medications */
  const [medications, setMedications] = useState([{ medicationText: "Paracetamol 500mg", dosageText: "One tablet twice a day after meal" }]);

  /* File upload */
  const fileInputRef = useRef(null);
  const [uploadFile, setUploadFile] = useState(null);
  const [uploadPreviewName, setUploadPreviewName] = useState("");

  /* Output JSON */
  const [jsonOut, setJsonOut] = useState("");

  /* Fetch patients on mount */
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/patients.json");
        const data = await res.json();
        const arr = Array.isArray(data) ? data : [];
        setPatients(arr);
        if (arr.length > 0) {
          setSelectedPatientIdx(0);
          const abhas = normalizeAbhaAddresses(arr[0]);
          setAbhaOptions(abhas);
          setSelectedAbha(abhas.length ? abhas[0].value : "");
        }
      } catch (e) {
        console.error("Failed to load patients.json", e);
      }
    })();
  }, []);

  /* When selected patient changes update ABHA options and selectedABHA */
  useEffect(() => {
    if (!selectedPatient) {
      setAbhaOptions([]);
      setSelectedAbha("");
      return;
    }
    const abhas = normalizeAbhaAddresses(selectedPatient);
    setAbhaOptions(abhas);
    setSelectedAbha(abhas.length ? abhas[0].value : "");
  }, [selectedPatient]);

  /* ------------------------- Medication helpers -------------------------- */
  function addMedication() {
    setMedications(prev => [...prev, { medicationText: "", dosageText: "One tablet twice a day after meal" }]);
  }
  function updateMedication(i, key, v) {
    setMedications(prev => prev.map((m, idx) => (idx === i ? { ...m, [key]: v } : m)));
  }
  function removeMedication(i) {
    setMedications(prev => prev.filter((_, idx) => idx !== i));
  }

  /* --------------------------- File upload handler ------------------------ */
  async function onFileChange(e) {
    const f = e.target.files?.[0];
    if (!f) return;
    const ok = f.type === "application/pdf" || f.type === "image/jpeg" || f.type === "image/jpg";
    if (!ok) {
      alert("Only PDF / JPG / JPEG allowed");
      return;
    }
    setUploadFile(f);
    setUploadPreviewName(f.name);
  }

  /* ----------------------------- Bundle builder -------------------------- */
  function buildPatientResource(patId) {
    if (!selectedPatient) return null;
    const identifiers = [];
    if (selectedPatient.abha_ref) identifiers.push({ system: "https://healthid.ndhm.gov.in", value: selectedPatient.abha_ref });
    const telecom = [];
    if (selectedPatient.mobile) telecom.push({ system: "phone", value: selectedPatient.mobile });
    if (selectedPatient.email) telecom.push({ system: "email", value: selectedPatient.email });
    if (selectedAbha) telecom.push({ system: "url", value: `abha://${selectedAbha}` });

    return {
      resourceType: "Patient",
      id: patId,
      language: "en-IN",
      text: buildNarrative("Patient", `<p>${selectedPatient.name}</p><p>${selectedPatient.gender || ""} ${selectedPatient.dob || ""}</p>`),
      identifier: identifiers,
      name: [{ text: selectedPatient.name }],
      gender: (selectedPatient.gender || "").toLowerCase(),
      birthDate: toFHIRDateFromDDMMYYYY(selectedPatient.dob) || undefined,
      telecom,
      address: selectedPatient.address ? [{ text: selectedPatient.address }] : undefined,
      meta: { profile: ["http://hl7.org/fhir/StructureDefinition/Patient"] },
    };
  }

  function buildPractitionerResource(pracId) {
    const p = PRACTITIONERS[selectedPractitionerIdx] || PRACTITIONERS[0];
    return {
      resourceType: "Practitioner",
      id: pracId,
      language: "en-IN",
      text: buildNarrative("Practitioner", `<p>${p.name}</p><p>${p.qualification}</p>`),
      identifier: p.registration?.system && p.registration?.value ? [{ system: p.registration.system, value: p.registration.value }] : undefined,
      name: [{ text: p.name }],
      telecom: [
        p.phone ? { system: "phone", value: p.phone } : null,
        p.email ? { system: "email", value: p.email } : null,
      ].filter(Boolean),
      qualification: p.qualification ? [{ code: { text: p.qualification } }] : undefined,
      meta: { profile: ["http://hl7.org/fhir/StructureDefinition/Practitioner"] },
    };
  }

  function buildEncounterResource(encId, patId) {
    const start = nowISOWithOffset();
    const end = nowISOWithOffset();
    return {
      resourceType: "Encounter",
      id: encId,
      language: "en-IN",
      text: buildNarrative("Encounter", "<p>Encounter for discharge</p>"),
      status: "finished",
      class: {
        system: "http://terminology.hl7.org/CodeSystem/v3-ActCode",
        code: "AMB",
        display: "ambulatory",
      },
      subject: { reference: `urn:uuid:${patId}` },
      period: { start, end },
      meta: { profile: ["http://hl7.org/fhir/StructureDefinition/Encounter"] },
    };
  }

  function buildMedicationRequests(medReqIds, patId, pracId, authoredOn) {
    return medications.map((m, idx) => ({
      resourceType: "MedicationRequest",
      id: medReqIds[idx],
      language: "en-IN",
      text: buildNarrative("MedicationRequest", `<p>${m.medicationText || ""}</p>`),
      status: "active",
      intent: "order",
      medicationCodeableConcept: m.medicationText?.trim() ? { text: m.medicationText.trim() } : { text: "Medication" },
      subject: { reference: `urn:uuid:${patId}` },
      authoredOn,
      requester: { reference: `urn:uuid:${pracId}`, display: "Practitioner" },
      dosageInstruction: buildDosageInstructionStandard(),
      meta: { profile: ["http://hl7.org/fhir/StructureDefinition/MedicationRequest"] },
    }));
  }

  function buildCarePlanResource(carePlanId, patId, pracId) {
    if (!carePlanText?.trim()) return null;
    return {
      resourceType: "CarePlan",
      id: carePlanId,
      language: "en-IN",
      text: buildNarrative("CarePlan", `<p>${carePlanText}</p>`),
      status: "active",
      intent: "plan",
      subject: { reference: `urn:uuid:${patId}` },
      author: [{ reference: `urn:uuid:${pracId}` }],
      activity: [{ detail: { kind: "ServiceRequest", description: carePlanText } }],
      meta: { profile: ["http://hl7.org/fhir/StructureDefinition/CarePlan"] },
    };
  }

  async function buildBinaryAndDocRef(binaryId, docRefId, patId) {
    let contentType = "application/pdf";
    let dataB64 = PLACEHOLDER_PDF_B64;
    if (uploadFile) {
      const ct = uploadFile.type;
      if (ct === "application/pdf" || ct === "image/jpeg" || ct === "image/jpg") contentType = ct;
      dataB64 = await fileToBase64NoPrefix(uploadFile);
    }

    const binary = {
      resourceType: "Binary",
      id: binaryId,
      language: "en-IN",
      meta: { profile: ["https://nrces.in/ndhm/fhir/r4/StructureDefinition/Binary"] },
      contentType,
      data: dataB64,
    };

    const docRef = {
      resourceType: "DocumentReference",
      id: docRefId,
      language: "en-IN",
      text: buildNarrative("DocumentReference", `<p>Discharge document</p>`),
      status: "current",
      type: { coding: [SNOMED.DOC_TYPE], text: "Discharge summary" },
      subject: { reference: `urn:uuid:${patId}` },
      date: nowISOWithOffset(),
      content: [{ attachment: { contentType, url: `urn:uuid:${binaryId}` } }],
      meta: { profile: ["http://hl7.org/fhir/StructureDefinition/DocumentReference"] },
    };

    return { binary, docRef };
  }

  function buildComposition(compId, patId, encId, pracId, authoredOn, medReqs, carePlan, docRef) {
    function makeSection(title, coding, textValue, entryRefs) {
      const sec = {
        title,
        code: { coding: [coding], text: coding.display },
      };
      if (entryRefs && entryRefs.length) sec.entry = entryRefs.map(ref => ({ reference: `urn:uuid:${ref.id}`, type: ref.type }));
      if (!sec.entry) {
        sec.text = {
          status: "generated",
          div: `<div xmlns="http://www.w3.org/1999/xhtml" lang="en-IN" xml:lang="en-IN"><p>${textValue || "No data"}</p></div>`,
        };
      }
      return sec;
    }

    const sections = [
      makeSection("Chief Complaints", SNOMED.SECTION_CHIEF, chiefComplaints, null),
      makeSection("Physical Examination", SNOMED.SECTION_PHYS, physicalExam, null),
      makeSection("Allergies", SNOMED.SECTION_ALLERGY, allergiesText, null),
      makeSection("Medical History", SNOMED.SECTION_MEDHIST, medicalHistoryText, null),
      makeSection("Family History", SNOMED.SECTION_FAMHIST, familyHistoryText, null),
      makeSection("Investigations", SNOMED.SECTION_INVEST, investigationsText, null),
      makeSection("Medications", SNOMED.SECTION_MEDS, medications.length ? "" : "No medications", medReqs.map(m => ({ id: m.id, type: "MedicationRequest" }))),
      makeSection("Procedures", SNOMED.SECTION_PROC, proceduresText, null),
      makeSection("Care Plan", SNOMED.SECTION_CAREPLAN, carePlanText, carePlan ? [{ id: carePlan.id, type: "CarePlan" }] : null),
      makeSection("Documents", SNOMED.SECTION_DOCREF, "Discharge documents attached", docRef ? [{ id: docRef.id, type: "DocumentReference" }] : null),
    ];

    return {
      resourceType: "Composition",
      id: compId,
      language: "en-IN",
      text: buildNarrative("Composition", `<p>${docTitle}</p>`),
      status: docStatus,
      type: { coding: [SNOMED.DOC_TYPE], text: "Discharge summary" }, // fixed
      subject: { reference: `urn:uuid:${patId}` },
      encounter: { reference: `urn:uuid:${encId}` },
      date: authoredOn,
      author: [{ reference: `urn:uuid:${pracId}` }],
      title: docTitle,
      section: sections,
      meta: { profile: ["http://hl7.org/fhir/StructureDefinition/Composition"] },
    };
  }

  async function onBuildJSON() {
    if (!selectedPatient) {
      alert("Please select a patient");
      return;
    }
    const authoredOn = nowISOWithOffset();

    // ids
    const bundleId = `DischargeSummaryBundle-${uuidv4()}`;
    const compId = uuidv4();
    const patId = uuidv4();
    const encId = uuidv4();
    const pracId = uuidv4();
    const medReqIds = medications.map(() => uuidv4());
    const carePlanId = carePlanText?.trim() ? uuidv4() : null;
    const binaryId = uuidv4();
    const docRefId = uuidv4();

    // resources
    const patientRes = buildPatientResource(patId);
    const practitionerRes = buildPractitionerResource(pracId);
    const encounterRes = buildEncounterResource(encId, patId);
    const medReqs = buildMedicationRequests(medReqIds, patId, pracId, authoredOn);
    const carePlanRes = carePlanId ? buildCarePlanResource(carePlanId, patId, pracId) : null;
    const { binary, docRef } = await buildBinaryAndDocRef(binaryId, docRefId, patId);

    const composition = buildComposition(compId, patId, encId, pracId, authoredOn, medReqs, carePlanRes, docRef);

    // Bundle with identifier using urn:ietf:rfc:3986 + urn:uuid
    const bundle = {
      resourceType: "Bundle",
      id: bundleId,
      meta: { profile: ["http://hl7.org/fhir/StructureDefinition/Bundle"], lastUpdated: authoredOn },
      identifier: { system: "urn:ietf:rfc:3986", value: `urn:uuid:${uuidv4()}` },
      type: "document",
      timestamp: authoredOn,
      entry: [
        { fullUrl: `urn:uuid:${compId}`, resource: composition },
        { fullUrl: `urn:uuid:${patId}`, resource: patientRes },
        { fullUrl: `urn:uuid:${pracId}`, resource: practitionerRes },
        { fullUrl: `urn:uuid:${encId}`, resource: encounterRes },
        ...medReqs.map((r, i) => ({ fullUrl: `urn:uuid:${medReqIds[i]}`, resource: r })),
        ...(carePlanRes ? [{ fullUrl: `urn:uuid:${carePlanId}`, resource: carePlanRes }] : []),
        { fullUrl: `urn:uuid:${docRefId}`, resource: docRef },
        { fullUrl: `urn:uuid:${binaryId}`, resource: binary },
      ],
    };

    setJsonOut(JSON.stringify(bundle, null, 2));
    console.log("Generated Discharge Summary Bundle:", bundle);
  }

  /* ------------------------------- RENDER UI -------------------------------- */
  return (
    <div className="container py-4">
      <h2 className="mb-3">Discharge Summary — Builder</h2>

      {/* Patient card */}
      <div className="card mb-3">
        <div className="card-header">1. Patient <span className="text-danger">*</span></div>
        <div className="card-body">
          <div className="row g-3 mb-2">
            <div className="col-md-8">
              <label className="form-label">Select Patient</label>
              <select className="form-select" value={selectedPatientIdx} onChange={e => setSelectedPatientIdx(Number(e.target.value))}>
                {patients.map((p, i) => (
                  <option key={p.id || i} value={i}>
                    {p.name} {p.abha_ref ? `(${p.abha_ref})` : ""}
                  </option>
                ))}
              </select>
            </div>
            <div className="col-md-4">
              <label className="form-label">ABHA Address</label>
              <select className="form-select" value={selectedAbha} onChange={e => setSelectedAbha(e.target.value)} disabled={!abhaOptions.length}>
                {abhaOptions.length === 0 ? <option value="">No ABHA addresses</option> : abhaOptions.map(a => <option key={a.value} value={a.value}>{a.label}</option>)}
              </select>
            </div>
          </div>

          {selectedPatient && (
            <>
              <div className="row g-3">
                <div className="col-md-6">
                  <label className="form-label">Name</label>
                  <input className="form-control" readOnly value={selectedPatient.name || ""} />
                </div>
                <div className="col-md-2">
                  <label className="form-label">Gender</label>
                  <input className="form-control" readOnly value={selectedPatient.gender || ""} />
                </div>
                <div className="col-md-2">
                  <label className="form-label">DOB</label>
                  <input className="form-control" readOnly value={selectedPatient.dob || ""} />
                </div>
                <div className="col-md-2">
                  <label className="form-label">Mobile</label>
                  <input className="form-control" readOnly value={selectedPatient.mobile || ""} />
                </div>

                <div className="col-12">
                  <label className="form-label">Address</label>
                  <textarea className="form-control" rows={2} readOnly value={selectedPatient.address || ""} />
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Practitioner card (global) */}
      <div className="card mb-3">
        <div className="card-header">2. Practitioner (Author) <span className="text-danger">*</span></div>
        <div className="card-body">
          <div className="row g-3">
            <div className="col-md-6">
              <label className="form-label">Select Practitioner</label>
              <select className="form-select" value={selectedPractitionerIdx} onChange={e => setSelectedPractitionerIdx(Number(e.target.value))}>
                {PRACTITIONERS.map((p, i) => <option key={p.id} value={i}>{p.name} ({p.qualification})</option>)}
              </select>
            </div>
            <div className="col-md-6">
              <label className="form-label">Name</label>
              <input className="form-control" readOnly value={PRACTITIONERS[selectedPractitionerIdx]?.name || ""} />
            </div>
          </div>
        </div>
      </div>

      {/* Composition meta */}
      <div className="card mb-3">
        <div className="card-header">3. Composition Metadata</div>
        <div className="card-body">
          <div className="row g-3">
            <div className="col-md-4">
              <label className="form-label">Status</label>
              <select className="form-select" value={docStatus} onChange={e => setDocStatus(e.target.value)}>
                <option value="preliminary">preliminary</option>
                <option value="final">final</option>
                <option value="amended">amended</option>
                <option value="entered-in-error">entered-in-error</option>
              </select>
            </div>
            <div className="col-md-8">
              <label className="form-label">Title</label>
              <input className="form-control" value={docTitle} onChange={e => setDocTitle(e.target.value)} />
            </div>
          </div>
        </div>
      </div>

      {/* Sections */}
      <div className="card mb-3">
        <div className="card-header">4. Sections</div>
        <div className="card-body">
          <div className="mb-3">
            <label className="form-label">Chief Complaints</label>
            <textarea className="form-control" rows={2} value={chiefComplaints} onChange={e => setChiefComplaints(e.target.value)} />
          </div>
          <div className="mb-3">
            <label className="form-label">Physical Examination</label>
            <textarea className="form-control" rows={2} value={physicalExam} onChange={e => setPhysicalExam(e.target.value)} />
          </div>
          <div className="mb-3">
            <label className="form-label">Allergies</label>
            <textarea className="form-control" rows={2} value={allergiesText} onChange={e => setAllergiesText(e.target.value)} />
          </div>
          <div className="mb-3">
            <label className="form-label">Medical History</label>
            <textarea className="form-control" rows={2} value={medicalHistoryText} onChange={e => setMedicalHistoryText(e.target.value)} />
          </div>
          <div className="mb-3">
            <label className="form-label">Family History</label>
            <textarea className="form-control" rows={2} value={familyHistoryText} onChange={e => setFamilyHistoryText(e.target.value)} />
          </div>
          <div className="mb-3">
            <label className="form-label">Investigations</label>
            <textarea className="form-control" rows={2} value={investigationsText} onChange={e => setInvestigationsText(e.target.value)} />
          </div>
          <div className="mb-3">
            <label className="form-label">Procedures</label>
            <textarea className="form-control" rows={2} value={proceduresText} onChange={e => setProceduresText(e.target.value)} />
          </div>
          <div className="mb-3">
            <label className="form-label">Care Plan</label>
            <textarea className="form-control" rows={2} value={carePlanText} onChange={e => setCarePlanText(e.target.value)} />
          </div>
        </div>
      </div>

      {/* Medications */}
      <div className="card mb-3">
        <div className="card-header">5. Medications (MedicationRequest)</div>
        <div className="card-body">
          {medications.map((m, i) => (
            <div className="border rounded p-2 mb-2" key={i}>
              <div className="row g-2">
                <div className="col-md-6">
                  <label className="form-label">Medication</label>
                  <input className="form-control" value={m.medicationText} onChange={e => updateMedication(i, "medicationText", e.target.value)} placeholder="e.g., Paracetamol 500mg" />
                </div>
                <div className="col-md-5">
                  <label className="form-label">Dosage text</label>
                  <input className="form-control" value={m.dosageText} onChange={e => updateMedication(i, "dosageText", e.target.value)} />
                </div>
                <div className="col-md-1 d-flex align-items-end">
                  <button className="btn btn-danger w-100" onClick={() => removeMedication(i)} disabled={medications.length === 1}>X</button>
                </div>
              </div>
            </div>
          ))}
          <button className="btn btn-sm btn-outline-secondary" onClick={addMedication}>+ Add medication</button>
        </div>
      </div>

      {/* Document upload */}
      <div className="card mb-3">
        <div className="card-header">6. Attach Discharge Document (PDF / JPG / JPEG)</div>
        <div className="card-body">
          <div className="mb-2">
            <input ref={fileInputRef} type="file" accept=".pdf,.jpg,.jpeg" onChange={onFileChange} />
          </div>
          {uploadPreviewName ? <div className="text-muted">Selected: {uploadPreviewName}</div> : <div className="text-muted">No file selected — a small PDF placeholder will be embedded.</div>}
        </div>
      </div>

      {/* Actions */}
      <div className="mb-4">
        <button className="btn btn-primary" onClick={onBuildJSON}>Build Discharge Summary JSON</button>
      </div>

      {/* Output */}
      <div className="card mb-5">
        <div className="card-header">Output JSON</div>
        <div className="card-body">
          <textarea className="form-control" rows={18} value={jsonOut} onChange={e => setJsonOut(e.target.value)} />
        </div>
      </div>
    </div>
  );
}
