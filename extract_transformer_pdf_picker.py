#!/usr/bin/env python3
"""
extract_transformer_pdf_picker.py
==================================
Extracts transformer oil analysis data from SKIC-BP PDF report
and outputs transformer_data.json for use with Dashboard V4.

Features:
  - File Picker GUI สำหรับเลือกไฟล์ PDF
  - Progress Bar แสดงความคืบหน้า
  - Save As Dialog สำหรับเลือก path บันทึก JSON
  - Log window แสดงสถานะการ extract

Requirements:
    pip install pdfplumber
    (tkinter มากับ Python ไม่ต้องติดตั้งเพิ่ม)
"""

import sys
import re
import json
import math
import threading
from pathlib import Path
import tkinter as tk
from tkinter import ttk, filedialog, messagebox, scrolledtext

try:
    import pdfplumber
    PDFPLUMBER_OK = True
except ImportError:
    PDFPLUMBER_OK = False


# ─────────────────────────────────────────────
#  Constants & Regex
# ─────────────────────────────────────────────

# Condition words (with or without space before them)
COND_WORDS = (
    r'(?:GOOD|good|Good|NA|Acceptable|acceptable|ACCEPTABLE|'
    r'Moderate|moderate|MODERATE|Poor|poor|POOR|'
    r'Fair|fair|FAIR|Normal|normal|NORMAL|'
    r'Serious|serious|SERIOUS|Extreme|extreme|EXTREME|'
    r'C1|C2|C3|C4)'
)

# "value COND" — space required (for most gases)
VALUE_COND_RE = re.compile(
    r'(-?\d+(?:\.\d+)?(?:[Ee][+-]?\d+)?)\s+' + COND_WORDS
)

# "valueC1" / "valueC2" — no space (TDCG format)
TDCG_RE = re.compile(r'(\d+(?:\.\d+)?)[Cc][1-4]')

# Plain numbers (for O2, N2, C3H8, C3H6)
NUM_RE = re.compile(r'(?<!\w)(\d+(?:\.\d+)?)(?!\w)')

# Date: "27-Mar-25"
DATE_RE = re.compile(
    r'\d{1,2}-(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-\d{2,4}'
)

# IEEE C57.104-2008 limits
GAS_LIMITS = {
    'H2':   {'C1': 100,  'C2': 700,   'C3': 1800},
    'CH4':  {'C1': 120,  'C2': 400,   'C3': 1000},
    'C2H2': {'C1': 1,    'C2': 9,     'C3': 35},
    'C2H4': {'C1': 50,   'C2': 100,   'C3': 200},
    'C2H6': {'C1': 65,   'C2': 100,   'C3': 150},
    'CO':   {'C1': 350,  'C2': 570,   'C3': 1400},
    'CO2':  {'C1': 2500, 'C2': 4000,  'C3': 10000},
    'TDCG': {'C1': 720,  'C2': 1920,  'C3': 4630},
}


# ─────────────────────────────────────────────
#  Helper Functions
# ─────────────────────────────────────────────
def safe_float(v):
    try:
        f = float(v)
        return None if math.isnan(f) or math.isinf(f) else f
    except (TypeError, ValueError):
        return None


def pair_vals_dates(vals, dates):
    """Align values with dates — take last n=min(len(vals),len(dates)) from each."""
    n = min(len(vals), len(dates))
    if n == 0:
        return [], []
    return list(dates[-n:]), list(vals[-n:])


def get_gas_condition(gas, value):
    if value is None:
        return 'C1'
    lim = GAS_LIMITS.get(gas)
    if not lim:
        return 'C1'
    if value > lim['C3']:
        return 'C4'
    elif value > lim['C2']:
        return 'C3'
    elif value > lim['C1']:
        return 'C2'
    return 'C1'


def get_overall_condition(tr):
    worst = 'C1'
    order = ['C1', 'C2', 'C3', 'C4']
    for gas in ['H2', 'CH4', 'C2H2', 'C2H4', 'C2H6', 'CO', 'CO2', 'TDCG']:
        v = tr.get(gas)
        if v is None:
            continue
        c = get_gas_condition(gas, v)
        if order.index(c) > order.index(worst):
            worst = c
    return {'C1': 'Normal', 'C2': 'Monitor', 'C3': 'Serious', 'C4': 'Extreme'}[worst]


def get_duval_fault(ch4, c2h4, c2h2):
    """
    Duval Triangle 1 — IEC 60599:2007 / IEEE C57.104-2008
    ใช้ %CH4, %C2H4, %C2H2 (normalized) เพื่อจัด fault zone

    PREREQUISITE (IEEE C57.104-2008):
      Duval Triangle เป็น Fault TYPE tool — ใช้เฉพาะเมื่อมีหลักฐานว่ามี Fault
      อย่างน้อย 1 ใน Duval gases ต้องเกิน IEEE C57.104 C1 limit:
        CH4 C1 = 120 ppm | C2H4 C1 = 50 ppm | C2H2 C1 = 1 ppm
      ถ้าทุกตัว <= C1 → ไม่มี Fault Indication → return None (N/A)

    Zone boundaries (จาก Duval Triangle diagram):
      D1 : %C2H2 >= 29%  หรือ  %C2H2 >= 13% และ %C2H4 < 23%
      D2 : %C2H2 >= 13% และ %C2H4 >= 23%
      DT : %C2H2 >= 4%  และ %C2H4 >= 15%  (mixed fault)
      T3 : %C2H4 >= 50% (high-temperature thermal)
      T2 : %C2H4 >= 20% (medium-temperature thermal)
      PD : %CH4 >= 98%  (corona — apex ของ triangle)
      T1 : ที่เหลือ (low-temperature thermal)
    """
    # ── Prerequisite: ตรวจสอบ C1 limit ก่อนคำนวณ Duval ────────────
    if (ch4 or 0) <= 120 and (c2h4 or 0) <= 50 and (c2h2 or 0) <= 1:
        return None  # ทุก Duval gas อยู่ใน C1 Normal — Duval N/A

    total = (ch4 or 0) + (c2h4 or 0) + (c2h2 or 0)
    if total < 1:
        return None
    pM = (ch4  or 0) / total * 100   # %CH4
    pE = (c2h4 or 0) / total * 100   # %C2H4
    pA = (c2h2 or 0) / total * 100   # %C2H2

    # ── Zone D1: C2H2 >= 29% ──────────────────────────────────
    if pA >= 29:
        return 'D1 — Electrical Discharge (Low Energy)'

    # ── Zone D1 / D2: C2H2 ระหว่าง 13–29% ────────────────────
    if pA >= 13:
        if pE >= 23:
            return 'D2 — Electrical Discharge (High Energy / Arcing)'
        else:
            return 'D1 — Electrical Discharge (Low Energy)'   # D1 zone ยื่นลงมา

    # ── Zone DT: C2H2 ระหว่าง 4–13% และ C2H4 >= 15% ──────────
    if pA >= 4 and pE >= 15:
        return 'DT — Mixture of Electrical + Thermal Faults'

    # ── Zone T3: C2H4 >= 50% ──────────────────────────────────
    if pE >= 50:
        return 'T3 — High Temperature Thermal Fault (>700 C)'

    # ── Zone T2: C2H4 >= 20% ──────────────────────────────────
    if pE >= 20:
        return 'T2 — Thermal Fault (300-700 C)'

    # ── Zone PD: CH4 >= 98% (apex) ────────────────────────────
    if pM >= 98:
        return 'PD — Corona Partial Discharges'

    # ── Zone T1: ที่เหลือ (low-temp thermal หรือ gas ต่ำมาก) ──
    return 'T1 — Low Temperature Thermal Fault (<300 C)'


def build_action(cond):
    return {
        'Normal':  'Normal operation',
        'Monitor': 'Monitor — schedule DGA retest within 1-3 months',
        'Serious': 'Plan outage — advise manufacturer, increase monitoring',
        'Extreme': 'Consider removal from service — consult manufacturer immediately',
    }.get(cond, 'Normal operation')


# ─────────────────────────────────────────────
#  PDF Page Loading
# ─────────────────────────────────────────────
def load_pages(pdf_path, progress_cb=None):
    pages = []
    with pdfplumber.open(pdf_path) as pdf:
        total = len(pdf.pages)
        for i, page in enumerate(pdf.pages):
            pages.append(page.extract_text() or '')
            if progress_cb:
                progress_cb(int((i + 1) / total * 25))
    return pages


def find_dga_pages(pages):
    """
    Detect DGA pages: contain 'Dissolved Gas Results' AND 'Equipment ID:'.
    Each transformer has exactly 5 pages: DGA, Ratio/Duval, Physical, Electrical, Chemical.
    """
    starts = []
    for i, text in enumerate(pages):
        if 'Dissolved Gas Results' in text and 'Equipment ID:' in text:
            starts.append(i)
    return starts


# ─────────────────────────────────────────────
#  Equipment Info Extraction
# ─────────────────────────────────────────────
def extract_equipment_info(text):
    """Extract equipment and sample info from any page header."""
    info = {}

    m = re.search(r'Equipment ID:\s*(.+?)(?:\s{2,}|Oil Type|\n)', text)
    info['equipment_id'] = m.group(1).strip() if m else ''

    m = re.search(r'Serial No\.:\s*(\S+)', text)
    info['serial_no'] = m.group(1).strip() if m else ''

    m = re.search(r'Rated power\s*\(kVA\):\s*(\d[\d,]*)', text)
    info['rated_power'] = m.group(1).replace(',', '') if m else ''

    m = re.search(r'Manufacturer:\s*(.+?)(?:\s{2,}|Received|\n)', text)
    info['manufacturer'] = m.group(1).strip() if m else ''

    m = re.search(r'Year:\s*(\d{4})', text)
    info['year'] = m.group(1) if m else ''

    m = re.search(r'Location:\s*(.+?)(?:\s{2,}|Report Number|\n)', text)
    raw_loc = m.group(1).strip() if m else 'SKIC-BP'
    info['location'] = re.sub(r'\s+', ' ', raw_loc).strip()

    m = re.search(r'Sampled:\s*(\d{1,2}-\w{3}-\d{2,4})', text)
    info['sampling_date'] = m.group(1).strip() if m else ''

    m = re.search(r'Completed:\s*(\d{1,2}-\w{3}-\d{2,4})', text)
    info['test_date'] = m.group(1).strip() if m else ''

    m = re.search(r'High voltage\s*\(V\):\s*(\d+)', text)
    info['high_voltage'] = m.group(1) if m else ''

    m = re.search(r'Low voltage\s*\(V\):\s*([\d/]+)', text)
    info['low_voltage'] = m.group(1) if m else ''

    return info


# ─────────────────────────────────────────────
#  DGA Extraction
# ─────────────────────────────────────────────
def extract_dga(text, current_date):
    """
    Extract DGA gas values and historical trends.
    Returns dict with gas values and gas_history_paired.
    """
    result = {}

    # ── Overall condition text ──
    m = re.search(r'Consider that the transformer has\s+(.+?)\s+Condition', text, re.IGNORECASE)
    result['dga_result'] = m.group(0).strip() if m else ''

    # ── DGA history dates ──
    date_line = ''
    for line in text.split('\n'):
        if 'Sample Date' in line and 'current sample' in line.lower():
            date_line = line
            break
    hist_dates = DATE_RE.findall(date_line)
    # Full date list includes current sampling date
    all_dates = hist_dates + ([current_date] if current_date else [])

    # ── Gas extraction ──
    # Gases with "value COND" format
    COND_GASES = {
        'H2':   r'Hydrogen\s+H2\b',
        'CO':   r'Carbon monoxide\s+CO\b',
        'CO2':  r'Carbon dioxide\s+CO2\b',
        'CH4':  r'Methane\s+CH4\b',
        'C2H6': r'Ethane\s+C2H6\b',
        'C2H4': r'Ethylene\s+C2H4\b',
        'C2H2': r'Acetylene\s+C2H2\b',
    }
    # Gases with plain numbers (no condition codes)
    PLAIN_GASES = {
        'O2':   r'Oxygen\s+O2\b',
        'N2':   r'Nitrogen\s+N2\b',
        'C3H8': r'Propane\s+C3H8\b',
        'C3H6': r'Propylene\s+C3H6\b',
    }

    gas_history = {}
    lines = text.split('\n')

    # Extract cond gases
    for gas, pattern in COND_GASES.items():
        for line in lines:
            if re.search(pattern, line, re.IGNORECASE):
                vals = [safe_float(m.group(1)) for m in VALUE_COND_RE.finditer(line)]
                if vals and all_dates:
                    d, v = pair_vals_dates(vals, all_dates)
                    gas_history[gas] = {'dates': d, 'values': v}
                    result[gas] = v[-1] if v else None
                break

    # Extract TDCG (no-space format: "115C1")
    for line in lines:
        if 'Total Dissolved Combustible Gas' in line or ('TDCG' in line and 'Rate' not in line and 'limit' not in line.lower() and 'Condition' not in line):
            # Try "value COND" first, then "valueC1" format
            vals = [safe_float(m.group(1)) for m in VALUE_COND_RE.finditer(line)]
            if not vals:
                vals = [safe_float(m.group(1)) for m in TDCG_RE.finditer(line)]
            if vals and all_dates:
                d, v = pair_vals_dates(vals, all_dates)
                gas_history['TDCG'] = {'dates': d, 'values': v}
                result['TDCG'] = v[-1] if v else None
            break

    # Compute TDCG if still missing
    if result.get('TDCG') is None:
        tdcg = sum(result.get(g) or 0 for g in ['H2', 'CO', 'CO2', 'CH4', 'C2H6', 'C2H4', 'C2H2'])
        result['TDCG'] = round(tdcg, 1)
        if all_dates:
            gas_history['TDCG'] = {'dates': [all_dates[-1]], 'values': [result['TDCG']]}

    # Extract plain-number gases
    for gas, pattern in PLAIN_GASES.items():
        for line in lines:
            if re.search(pattern, line, re.IGNORECASE):
                # Extract numbers, skip "-"
                raw = re.sub(r'\s*-\s*', ' ', line)
                # Remove gas name part
                raw = re.sub(pattern, '', raw, flags=re.IGNORECASE)
                nums = [safe_float(x) for x in NUM_RE.findall(raw) if safe_float(x) is not None]
                if nums and all_dates:
                    d, v = pair_vals_dates(nums, all_dates)
                    gas_history[gas] = {'dates': d, 'values': v}
                    result[gas] = v[-1] if v else None
                break

    result['gas_history_paired'] = gas_history
    return result


# ─────────────────────────────────────────────
#  Physical Test Extraction
# ─────────────────────────────────────────────
def extract_physical(text, current_date):
    result = {'dates': [], 'color': {}, 'IFT': {}}

    # Date line: "IEEE C57-106TM-2015 9-Apr-24 Current Sample"
    date_line = ''
    for line in text.split('\n'):
        if ('IEEE C57' in line or 'C57-106' in line) and 'Current Sample' in line:
            date_line = line
            break

    hist_dates = DATE_RE.findall(date_line)
    all_dates = hist_dates + ([current_date] if current_date else [])
    if not all_dates:
        return result
    result['dates'] = all_dates

    for line in text.split('\n'):
        ll = line.lower()
        if 'color number' in ll and 'astm' in ll:
            vals = [safe_float(m.group(1)) for m in VALUE_COND_RE.finditer(line)]
            if vals:
                d, v = pair_vals_dates(vals, all_dates)
                result['color'] = {'dates': d, 'values': v}
        elif 'interfacial tension' in ll and 'astm' in ll:
            vals = [safe_float(m.group(1)) for m in VALUE_COND_RE.finditer(line)]
            if vals:
                d, v = pair_vals_dates(vals, all_dates)
                result['IFT'] = {'dates': d, 'values': v}

    return result


# ─────────────────────────────────────────────
#  Electrical Test Extraction
# ─────────────────────────────────────────────
def extract_electrical(text, current_date):
    result = {'dates': [], 'DF25': {}, 'DBV': {}}

    # Date line is standalone after "aIEEE C57-106-2015" line
    date_line = ''
    lines = text.split('\n')
    found_ieee = False
    for line in lines:
        if 'aIEEE C57-106' in line or 'IEEE C57-106-2015' in line:
            found_ieee = True
            if DATE_RE.search(line):
                date_line = line
                break
            continue
        if found_ieee and DATE_RE.search(line) and 'voltage' not in line.lower():
            date_line = line
            break

    if not date_line:
        for line in lines:
            if 'Current Sample' in line and DATE_RE.search(line):
                date_line = line
                break

    hist_dates = DATE_RE.findall(date_line)
    all_dates = hist_dates + ([current_date] if current_date else [])
    if not all_dates:
        return result
    result['dates'] = all_dates

    for line in lines:
        ll = line.lower()
        if 'dissipation factor' in ll and '25' in line and 'astm' in ll:
            vals = [safe_float(m.group(1)) for m in VALUE_COND_RE.finditer(line)]
            if vals:
                d, v = pair_vals_dates(vals, all_dates)
                result['DF25'] = {'dates': d, 'values': v}
        elif 'd877' in ll or ('dielectric breakdown voltage' in ll and 'd877' in ll.lower()):
            vals = [safe_float(m.group(1)) for m in VALUE_COND_RE.finditer(line)]
            if vals:
                d, v = pair_vals_dates(vals, all_dates)
                result['DBV'] = {'dates': d, 'values': v}

    # Fallback: any DBV line
    if not result['DBV']:
        for line in lines:
            if 'dielectric breakdown voltage' in line.lower() and 'astm d877' in line.lower():
                vals = [safe_float(m.group(1)) for m in VALUE_COND_RE.finditer(line)]
                if vals:
                    d, v = pair_vals_dates(vals, all_dates)
                    result['DBV'] = {'dates': d, 'values': v}
                    break

    return result


# ─────────────────────────────────────────────
#  Chemical Test Extraction
# ─────────────────────────────────────────────
def extract_chemical(text, current_date):
    result = {'dates': [], 'acidity': {}, 'moisture': {},
              'water_in_oil': {}, 'water_in_paper': {}}

    date_line = ''
    for line in text.split('\n'):
        if ('IEEE C57' in line or 'C57-106' in line) and 'Current Sample' in line:
            date_line = line
            break

    hist_dates = DATE_RE.findall(date_line)
    all_dates = hist_dates + ([current_date] if current_date else [])
    if not all_dates:
        return result
    result['dates'] = all_dates

    for line in text.split('\n'):
        ll = line.lower()
        if 'acid number' in ll and 'astm' in ll:
            vals = [safe_float(m.group(1)) for m in VALUE_COND_RE.finditer(line)]
            if vals:
                d, v = pair_vals_dates(vals, all_dates)
                result['acidity'] = {'dates': d, 'values': v}
        elif ('water in insulating liquid' in ll or 'water content' in ll) and 'astm' in ll:
            vals = [safe_float(m.group(1)) for m in VALUE_COND_RE.finditer(line)]
            if vals:
                d, v = pair_vals_dates(vals, all_dates)
                result['moisture'] = {'dates': d, 'values': v}
        elif ('water in oil' in ll or 'saturation of water' in ll or
              ('% saturation' in ll and 'oil' in ll) or '% wet saturation' in ll):
            vals = [safe_float(m.group(1)) for m in VALUE_COND_RE.finditer(line)]
            if not vals:
                vals = [f for f in [safe_float(m.group(1)) for m in NUM_RE.finditer(line)]
                        if f is not None and 0 <= f <= 100]
            if vals:
                d, v = pair_vals_dates(vals, all_dates)
                result['water_in_oil'] = {'dates': d, 'values': v}
        elif ('water in paper' in ll or 'moisture in paper' in ll or
              ('% moisture' in ll and 'paper' in ll)):
            vals = [safe_float(m.group(1)) for m in VALUE_COND_RE.finditer(line)]
            if not vals:
                vals = [f for f in [safe_float(m.group(1)) for m in NUM_RE.finditer(line)]
                        if f is not None and 0 <= f <= 20]
            if vals:
                d, v = pair_vals_dates(vals, all_dates)
                result['water_in_paper'] = {'dates': d, 'values': v}

    return result


def get_last_val(hist, key):
    vals = hist.get(key, {}).get('values', [])
    return vals[-1] if vals else None


# ─────────────────────────────────────────────
#  Main Extraction
# ─────────────────────────────────────────────
def extract_all(pdf_path, log_cb=None, progress_cb=None):
    def log(msg):
        if log_cb:
            log_cb(msg)

    log(f"Opening: {Path(pdf_path).name}")
    pages = load_pages(pdf_path, progress_cb)
    log(f"Total pages: {len(pages)}")

    tr_starts = find_dga_pages(pages)
    log(f"Found {len(tr_starts)} transformers")

    if not tr_starts:
        raise ValueError("ไม่พบข้อมูล Transformer ในไฟล์ PDF นี้ กรุณาตรวจสอบว่าเป็น SKIC-BP Report")

    transformers = []
    n = len(tr_starts)

    for idx, start_page in enumerate(tr_starts):
        dga_text  = pages[start_page]
        phys_text = pages[start_page + 2] if start_page + 2 < len(pages) else ''
        elec_text = pages[start_page + 3] if start_page + 3 < len(pages) else ''
        chem_text = pages[start_page + 4] if start_page + 4 < len(pages) else ''

        # Equipment info (from DGA page header)
        eq = extract_equipment_info(dga_text)
        current_date = eq.get('sampling_date', '')

        # Extract sections
        dga  = extract_dga(dga_text, current_date)
        phys = extract_physical(phys_text, current_date)
        elec = extract_electrical(elec_text, current_date)
        chem = extract_chemical(chem_text, current_date)

        # Current test values
        color_val    = get_last_val(phys, 'color')
        IFT_val      = get_last_val(phys, 'IFT')
        DF25_val     = get_last_val(elec, 'DF25')
        DBV_val      = get_last_val(elec, 'DBV')
        acidity_val        = get_last_val(chem, 'acidity')
        moisture_val       = get_last_val(chem, 'moisture')
        water_in_oil_val   = get_last_val(chem, 'water_in_oil')
        water_in_paper_val = get_last_val(chem, 'water_in_paper')

        tr = {
            'no':            idx + 1,
            'equipment_id':  eq.get('equipment_id', ''),
            'serial_no':     eq.get('serial_no', ''),
            'rated_power':   eq.get('rated_power', ''),
            'manufacturer':  eq.get('manufacturer', ''),
            'year':          eq.get('year', ''),
            'location':      eq.get('location', 'SKIC-BP'),
            'sampling_date': eq.get('sampling_date', ''),
            'test_date':     eq.get('test_date', ''),
            'high_voltage':  eq.get('high_voltage', ''),
            'low_voltage':   eq.get('low_voltage', ''),

            # DGA gases (current values)
            'H2':   dga.get('H2'),   'CO':   dga.get('CO'),
            'CO2':  dga.get('CO2'),  'CH4':  dga.get('CH4'),
            'C2H6': dga.get('C2H6'),'C2H4': dga.get('C2H4'),
            'C2H2': dga.get('C2H2'),'C3H6': dga.get('C3H6'),
            'C3H8': dga.get('C3H8'),'O2':   dga.get('O2'),
            'N2':   dga.get('N2'),   'TDCG': dga.get('TDCG'),

            # Physical / Electrical / Chemical
            'color_number': color_val,
            'IFT':          IFT_val,
            'DBV':          DBV_val,
            'DF_25C':       DF25_val,
            'DF_100C':      None,
            'acidity':           acidity_val,
            'moisture_ppm':      moisture_val,
            'water_in_oil_pct':  water_in_oil_val,
            'water_in_paper_pct': water_in_paper_val,

            'dga_result':        dga.get('dga_result', ''),

            # Historical data
            'gas_history_paired': dga.get('gas_history_paired', {}),
            'phys_history':       phys,
            'elec_history':       elec,
            'chem_history':       chem,

            # Compatibility fields
            'sample_dates':   [],
            'gas_history':    list(dga.get('gas_history_paired', {}).keys()),
            'paired_history': list(dga.get('gas_history_paired', {}).keys()),
            'all_dates':      [],
            'full_dates':     [],
            'recommendation_summary': '',
        }

        tr['dga_condition'] = get_overall_condition(tr)
        tr['duval_fault']   = get_duval_fault(tr.get('CH4'), tr.get('C2H4'), tr.get('C2H2'))

        co2  = tr.get('CO2') or 0
        co   = tr.get('CO')  or 0.001
        tr['co2_co_ratio'] = round(co2 / co, 2)

        # Rogers Ratios — ใช้เฉพาะเมื่อ DGA ไม่ใช่ Normal (C1)
        if tr['dga_condition'] != 'Normal':
            c2h2 = tr.get('C2H2') or 0
            c2h4 = tr.get('C2H4') or 0.001
            ch4  = tr.get('CH4')  or 0.001
            h2   = tr.get('H2')   or 0.001
            c2h6 = tr.get('C2H6') or 0.001
            tr['rogers_r1'] = round(c2h2 / c2h4, 4)
            tr['rogers_r2'] = round(ch4 / h2, 4)
            tr['rogers_r3'] = round(c2h4 / c2h6, 4)
        else:
            tr['rogers_r1'] = None
            tr['rogers_r2'] = None
            tr['rogers_r3'] = None

        cond = tr['dga_condition']
        tr['dga_diagnosis']        = f"Consider that the transformer has {cond} condition."
        tr['action']               = build_action(cond)
        tr['physical_diagnosis']   = 'The oil color and Interfacial tension are in Normal condition.'
        tr['electrical_diagnosis'] = 'The dissipation factor 25C and dielectric breakdown voltage are in Normal condition.'
        tr['chemical_diagnosis']   = 'The acid number and water content are in Normal condition.'

        transformers.append(tr)

        if progress_cb:
            progress_cb(25 + int((idx + 1) / n * 70))

        tdcg_val = tr.get('TDCG') or 0
        log(f"  TR{tr['no']:>2}  {tr['equipment_id']:<26} TDCG={tdcg_val:>7.1f} ppm  [{cond}]")

    return transformers


# ─────────────────────────────────────────────
#  GUI Application
# ─────────────────────────────────────────────
class App(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("Transformer PDF Extractor — Dashboard V4")
        self.resizable(True, True)
        self.minsize(620, 500)
        self._build_ui()
        self._center_window(700, 580)

    def _center_window(self, w, h):
        sw, sh = self.winfo_screenwidth(), self.winfo_screenheight()
        self.geometry(f"{w}x{h}+{(sw-w)//2}+{(sh-h)//2}")

    def _build_ui(self):
        BG     = '#1a2e4a'
        FG     = '#ffffff'
        ACCENT = '#2563eb'

        self.configure(bg=BG)
        style = ttk.Style(self)
        style.theme_use('clam')
        style.configure('TFrame',        background=BG)
        style.configure('TLabel',        background=BG, foreground=FG, font=('Segoe UI', 10))
        style.configure('Header.TLabel', background=BG, foreground=FG, font=('Segoe UI', 14, 'bold'))
        style.configure('Sub.TLabel',    background=BG, foreground='#94a3b8', font=('Segoe UI', 9))
        style.configure('Accent.TButton', font=('Segoe UI', 10, 'bold'),
                        foreground='white', background=ACCENT, padding=6)
        style.map('Accent.TButton', background=[('active', '#1d4ed8')])
        style.configure('TProgressbar', troughcolor='#243d5e', background=ACCENT, thickness=8)

        # Header
        hdr = ttk.Frame(self)
        hdr.pack(fill='x', padx=20, pady=(20, 10))
        ttk.Label(hdr, text="Transformer PDF Extractor", style='Header.TLabel').pack(anchor='w')
        ttk.Label(hdr, text="แปลง PDF Report → JSON สำหรับ Dashboard V4  |  IEEE C57.104-2008",
                  style='Sub.TLabel').pack(anchor='w')

        ttk.Separator(self, orient='horizontal').pack(fill='x', padx=20, pady=(0, 10))

        # PDF File Picker
        f1 = ttk.Frame(self)
        f1.pack(fill='x', padx=20, pady=4)
        ttk.Label(f1, text="PDF Report:", width=15).pack(side='left')
        self.pdf_var = tk.StringVar()
        ttk.Entry(f1, textvariable=self.pdf_var, font=('Segoe UI', 9)
                  ).pack(side='left', padx=(4, 4), expand=True, fill='x')
        ttk.Button(f1, text="Browse...", command=self._pick_pdf,
                   style='Accent.TButton').pack(side='left')

        # JSON Output
        f2 = ttk.Frame(self)
        f2.pack(fill='x', padx=20, pady=4)
        ttk.Label(f2, text="Save JSON As:", width=15).pack(side='left')
        self.json_var = tk.StringVar()
        ttk.Entry(f2, textvariable=self.json_var, font=('Segoe UI', 9)
                  ).pack(side='left', padx=(4, 4), expand=True, fill='x')
        ttk.Button(f2, text="Browse...", command=self._pick_json,
                   style='Accent.TButton').pack(side='left')

        # Git Auto-Push Checkbox
        f_git = ttk.Frame(self)
        f_git.pack(fill='x', padx=20, pady=(0, 4))
        self.git_push_var = tk.BooleanVar(value=False)
        ttk.Checkbutton(f_git, text="Auto-commit & push data.json to GitHub after extraction", 
                        variable=self.git_push_var).pack(side='left')

        ttk.Separator(self, orient='horizontal').pack(fill='x', padx=20, pady=(10, 6))

        # Progress
        f3 = ttk.Frame(self)
        f3.pack(fill='x', padx=20, pady=2)
        self.progress_var = tk.IntVar(value=0)
        ttk.Progressbar(f3, variable=self.progress_var, maximum=100,
                        style='TProgressbar').pack(fill='x')
        self.status_var = tk.StringVar(value="พร้อมใช้งาน — กด Browse เพื่อเลือกไฟล์ PDF")
        ttk.Label(f3, textvariable=self.status_var, style='Sub.TLabel').pack(anchor='w', pady=(4, 0))

        # Log
        log_frame = ttk.Frame(self)
        log_frame.pack(fill='both', expand=True, padx=20, pady=(6, 6))
        ttk.Label(log_frame, text="Extraction Log:", style='Sub.TLabel').pack(anchor='w')
        self.log_box = scrolledtext.ScrolledText(
            log_frame, height=13, font=('Consolas', 9),
            bg='#0f1f35', fg='#e2e8f0', insertbackground='white',
            relief='flat', state='disabled', wrap='word'
        )
        self.log_box.pack(fill='both', expand=True)

        # Buttons
        btn_frame = ttk.Frame(self)
        btn_frame.pack(fill='x', padx=20, pady=(0, 16))
        self.run_btn = ttk.Button(btn_frame, text="  Extract & Save JSON",
                                  command=self._run, style='Accent.TButton')
        self.run_btn.pack(side='left', ipadx=10)
        ttk.Button(btn_frame, text="Clear Log",
                   command=self._clear_log).pack(side='left', padx=(8, 0))

        if not PDFPLUMBER_OK:
            self._log("ERROR: pdfplumber ไม่ได้ติดตั้ง")
            self._log("กรุณาเปิด Command Prompt แล้วรัน: pip install pdfplumber")
            self._log("จากนั้นเปิดโปรแกรมนี้ใหม่อีกครั้ง")
            self.run_btn.config(state='disabled')

    def _pick_pdf(self):
        path = filedialog.askopenfilename(
            title="เลือกไฟล์ PDF Report",
            filetypes=[("PDF Files", "*.pdf"), ("All Files", "*.*")]
        )
        if path:
            self.pdf_var.set(path)
            default_json = str(Path(path).parent / 'data.json')
            self.json_var.set(default_json)
            self._log(f"เลือกไฟล์: {Path(path).name}")

    def _pick_json(self):
        path = filedialog.asksaveasfilename(
            title="บันทึก JSON เป็น...",
            defaultextension=".json",
            filetypes=[("JSON Files", "*.json"), ("All Files", "*.*")],
            initialfile="data.json"
        )
        if path:
            self.json_var.set(path)

    def _log(self, msg):
        self.log_box.config(state='normal')
        self.log_box.insert('end', msg + '\n')
        self.log_box.see('end')
        self.log_box.config(state='disabled')

    def _clear_log(self):
        self.log_box.config(state='normal')
        self.log_box.delete('1.0', 'end')
        self.log_box.config(state='disabled')

    def _set_progress(self, val):
        self.progress_var.set(val)
        self.update_idletasks()

    def _run(self):
        pdf = self.pdf_var.get().strip()
        out = self.json_var.get().strip()
        if not pdf:
            messagebox.showwarning("แจ้งเตือน", "กรุณาเลือกไฟล์ PDF ก่อน")
            return
        if not Path(pdf).exists():
            messagebox.showerror("Error", f"ไม่พบไฟล์:\n{pdf}")
            return
        if not out:
            messagebox.showwarning("แจ้งเตือน", "กรุณาระบุ path สำหรับบันทึก JSON")
            return

        self.run_btn.config(state='disabled')
        self._set_progress(0)
        self.status_var.set("กำลัง Extract...")

        def worker():
            try:
                data = extract_all(
                    pdf,
                    log_cb=lambda m: self.after(0, self._log, m),
                    progress_cb=lambda p: self.after(0, self._set_progress, p)
                )
                with open(out, 'w', encoding='utf-8') as f:
                    json.dump(data, f, ensure_ascii=False, indent=2)

                if self.git_push_var.get():
                    self.after(0, self.status_var.set, "กำลัง Push ขึ้น GitHub...")
                    self.after(0, self._log, "Running Git commands...")
                    try:
                        import subprocess
                        out_dir = Path(out).parent
                        subprocess.run(['git', 'add', Path(out).name], cwd=out_dir, check=True, capture_output=True)
                        subprocess.run(['git', 'commit', '-m', f"Update Transformer Data: {Path(out).name}"], cwd=out_dir, check=True, capture_output=True)
                        subprocess.run(['git', 'push'], cwd=out_dir, check=True, capture_output=True, text=True)
                        self.after(0, self._log, "✅ Git push สำเร็จ!")
                    except Exception as e:
                        self.after(0, self._log, f"❌ Git push failed: {e}")
                        if hasattr(e, 'stderr') and e.stderr:
                            stderr_str = e.stderr.decode('utf-8') if isinstance(e.stderr, bytes) else e.stderr
                            self.after(0, self._log, f"Git stderr: {stderr_str}")

                size_kb = Path(out).stat().st_size / 1024
                self.after(0, self._set_progress, 100)
                self.after(0, self.status_var.set,
                           f"สำเร็จ! {len(data)} Transformers → {Path(out).name} ({size_kb:.1f} KB)")
                self.after(0, self._log, "")
                self.after(0, self._log, f"บันทึกสำเร็จ: {out}")
                self.after(0, self._log, f"  Transformers: {len(data)} | Size: {size_kb:.1f} KB")
                self.after(0, self._log, "")
                self.after(0, self._log, "ขั้นตอนถัดไป:")
                self.after(0, self._log, "  1. เปิด transformer_oil_dashboard_v4.html ด้วย Browser")
                self.after(0, self._log, f"  2. Upload ไฟล์ {Path(out).name}")
                self.after(0, messagebox.showinfo, "สำเร็จ",
                           f"Extract เสร็จแล้ว!\n\n"
                           f"Transformers: {len(data)} รายการ\n"
                           f"บันทึกที่: {out}\n\n"
                           f"นำไฟล์ JSON ไป Upload ใน Dashboard V4")
            except Exception as e:
                self.after(0, self._log, f"ERROR: {e}")
                self.after(0, self.status_var.set, f"เกิดข้อผิดพลาด: {e}")
                self.after(0, messagebox.showerror, "Error", str(e))
            finally:
                self.after(0, self.run_btn.config, {'state': 'normal'})

        threading.Thread(target=worker, daemon=True).start()


if __name__ == '__main__':
    app = App()
    app.mainloop()
