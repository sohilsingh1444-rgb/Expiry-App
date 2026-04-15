import io
import re
import hashlib
from datetime import date, datetime

import pandas as pd
import streamlit as st

st.set_page_config(page_title="Expiry Scan App", layout="centered")


# =========================================================
# Helpers
# =========================================================
def clean_barcode(value) -> str:
    if value is None:
        return ""

    s = str(value).strip()
    if not s:
        return ""

    s = s.replace("\n", "").replace("\r", "").replace("\t", "")
    s = re.sub(r"\s+", "", s)

    try:
        if re.fullmatch(r"[-+]?\d+(\.\d+)?([eE][-+]?\d+)?", s):
            num = float(s)
            if num.is_integer():
                return str(int(num))
            return format(num, "f").rstrip("0").rstrip(".")
    except Exception:
        pass

    if s.endswith(".0"):
        s = s[:-2]

    return s


def find_column(columns, candidates):
    normalized = {
        str(c).strip().lower().replace(".", "").replace("_", " "): c
        for c in columns
    }
    for cand in candidates:
        key = cand.strip().lower().replace(".", "").replace("_", " ")
        if key in normalized:
            return normalized[key]
    return None


def prepare_barcode_master(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    df.columns = [str(c).strip() for c in df.columns]

    barcode_col = find_column(
        df.columns,
        ["barcode", "barcode no", "bar code", "ean", "upc", "item barcode", "code"],
    )
    item_col = find_column(
        df.columns,
        ["item no", "item number", "item", "item_no", "no", "item code"],
    )
    desc_col = find_column(
        df.columns,
        ["description", "item description", "desc", "product description", "retail item"],
    )

    if barcode_col is None:
        raise ValueError("Barcode column not found in barcode master.")

    if item_col is None:
        df["__item"] = ""
        item_col = "__item"

    if desc_col is None:
        df["__desc"] = ""
        desc_col = "__desc"

    out = df[[barcode_col, item_col, desc_col]].copy()
    out.columns = ["Barcode", "Item Number", "Description"]

    out["Barcode"] = out["Barcode"].apply(clean_barcode)
    out["Item Number"] = out["Item Number"].fillna("").astype(str).str.strip()
    out["Description"] = out["Description"].fillna("").astype(str).str.strip()

    out = out[out["Barcode"] != ""]
    out = out.drop_duplicates(subset=["Barcode"], keep="first")
    return out


def file_hash(file_bytes: bytes) -> str:
    return hashlib.md5(file_bytes).hexdigest()


@st.cache_data(show_spinner=False)
def load_barcode_master_from_bytes(file_bytes: bytes, file_name: str) -> pd.DataFrame:
    if file_name.lower().endswith(".csv"):
        try:
            df = pd.read_csv(io.BytesIO(file_bytes), dtype=str, low_memory=False)
        except UnicodeDecodeError:
            df = pd.read_csv(io.BytesIO(file_bytes), dtype=str, encoding="latin1", low_memory=False)
    else:
        df = pd.read_excel(io.BytesIO(file_bytes), dtype=str)

    return prepare_barcode_master(df)


def get_status(expiry_date_value, today_value):
    days_left = (expiry_date_value - today_value).days
    if days_left < 0:
        return "Expired", days_left, "Remove immediately"
    if days_left <= 3:
        return "Near Expiry", days_left, "Check / markdown"
    return "OK", days_left, "No action"


def to_excel(df: pd.DataFrame) -> bytes:
    output = io.BytesIO()

    with pd.ExcelWriter(
        output,
        engine="xlsxwriter",
        date_format="dd/mm/yyyy",
        datetime_format="dd/mm/yyyy",
    ) as writer:
        df.to_excel(writer, index=False, sheet_name="Expiry Report")

        workbook = writer.book
        worksheet = writer.sheets["Expiry Report"]

        header_fmt = workbook.add_format({
            "bold": True,
            "border": 1,
            "align": "center",
            "valign": "vcenter",
            "bg_color": "#D9EAF7"
        })

        cell_fmt = workbook.add_format({
            "border": 1,
            "valign": "vcenter"
        })

        center_fmt = workbook.add_format({
            "border": 1,
            "align": "center",
            "valign": "vcenter"
        })

        date_fmt = workbook.add_format({
            "border": 1,
            "align": "center",
            "valign": "vcenter",
            "num_format": "dd/mm/yyyy"
        })

        qty_fmt = workbook.add_format({
            "border": 1,
            "align": "center",
            "valign": "vcenter",
            "num_format": "0.00"
        })

        barcode_fmt = workbook.add_format({
            "border": 1,
            "align": "center",
            "valign": "vcenter",
            "num_format": "@"
        })

        expired_fmt = workbook.add_format({
            "bg_color": "#FFC7CE",
            "font_color": "#9C0006",
            "border": 1
        })

        near_fmt = workbook.add_format({
            "bg_color": "#FFEB9C",
            "font_color": "#9C6500",
            "border": 1
        })

        ok_fmt = workbook.add_format({
            "bg_color": "#C6EFCE",
            "font_color": "#006100",
            "border": 1
        })

        for col_num, col_name in enumerate(df.columns):
            worksheet.write(0, col_num, col_name, header_fmt)

        expiry_col_excel = "G"
        status_col_excel = "H"

        for row_num, row in df.iterrows():
            excel_row = row_num + 1

            for col_num, col_name in enumerate(df.columns):
                value = row[col_name]

                if col_name == "Barcode":
                    worksheet.write_string(excel_row, col_num, str(value), barcode_fmt)
                elif col_name in ["Expiry Date", "Scan Date"]:
                    worksheet.write_datetime(
                        excel_row,
                        col_num,
                        datetime.combine(pd.to_datetime(value).date(), datetime.min.time()),
                        date_fmt
                    )
                elif col_name == "Qty":
                    worksheet.write_number(excel_row, col_num, float(value), qty_fmt)
                elif col_name == "Days Left":
                    worksheet.write_formula(
                        excel_row,
                        col_num,
                        f"={expiry_col_excel}{excel_row+1}-TODAY()",
                        center_fmt
                    )
                elif col_name == "Status":
                    worksheet.write_formula(
                        excel_row,
                        col_num,
                        f'=IF({expiry_col_excel}{excel_row+1}<TODAY(),"Expired",IF({expiry_col_excel}{excel_row+1}-TODAY()<=3,"Near Expiry","OK"))',
                        center_fmt,
                    )
                elif col_name == "Action Required":
                    worksheet.write_formula(
                        excel_row,
                        col_num,
                        f'=IF({status_col_excel}{excel_row+1}="Expired","Remove immediately",IF({status_col_excel}{excel_row+1}="Near Expiry","Check / markdown","No action"))',
                        cell_fmt,
                    )
                else:
                    worksheet.write(excel_row, col_num, value, cell_fmt)

        widths = {
            "PD/User Name": 18,
            "Store / Location": 16,
            "Barcode": 18,
            "Item Number": 15,
            "Description": 38,
            "Qty": 8,
            "Expiry Date": 12,
            "Status": 14,
            "Days Left": 10,
            "Scan Date": 12,
            "Action Required": 22,
            "Remarks": 20,
        }

        for i, col in enumerate(df.columns):
            worksheet.set_column(i, i, widths.get(col, 15))

        worksheet.freeze_panes(1, 0)

        status_col = list(df.columns).index("Status")
        last_row = len(df)

        if last_row > 0:
            worksheet.conditional_format(1, status_col, last_row, status_col, {
                "type": "text",
                "criteria": "containing",
                "value": "Expired",
                "format": expired_fmt,
            })
            worksheet.conditional_format(1, status_col, last_row, status_col, {
                "type": "text",
                "criteria": "containing",
                "value": "Near Expiry",
                "format": near_fmt,
            })
            worksheet.conditional_format(1, status_col, last_row, status_col, {
                "type": "text",
                "criteria": "containing",
                "value": "OK",
                "format": ok_fmt,
            })

    output.seek(0)
    return output.getvalue()


# =========================================================
# Session state
# =========================================================
defaults = {
    "barcode_lookup": {},
    "master_loaded": False,
    "master_file_hash": "",
    "master_file_name": "",
    "rows": [],
    "save_message": "",
    "form_pd_user": "",
    "form_store_location": "",
    "form_barcode": "",
    "form_qty": 1.0,
    "form_expiry_date": date.today(),
    "form_remarks": "",
    "reset_scan_fields": False,
}

for key, value in defaults.items():
    if key not in st.session_state:
        st.session_state[key] = value


# =========================================================
# Reset fields BEFORE widgets render
# =========================================================
if st.session_state.reset_scan_fields:
    st.session_state.form_barcode = ""
    st.session_state.form_qty = 1.0
    st.session_state.form_expiry_date = date.today()
    st.session_state.form_remarks = ""
    st.session_state.reset_scan_fields = False


# =========================================================
# Page styling
# =========================================================
st.markdown(
    """
    <style>
    .block-container {
        max-width: 820px;
        padding-top: 1.5rem;
        padding-bottom: 2rem;
    }
    </style>
    """,
    unsafe_allow_html=True
)

st.title("Expiry Scan App")


# =========================================================
# Load barcode master
# =========================================================
uploaded_file = st.file_uploader(
    "Upload Barcode Master (CSV / XLSX / XLS format):",
    type=["csv", "xlsx", "xls"]
)

if uploaded_file is not None:
    try:
        file_bytes = uploaded_file.getvalue()
        current_hash = file_hash(file_bytes)

        if (
            not st.session_state.master_loaded
            or st.session_state.master_file_hash != current_hash
            or st.session_state.master_file_name != uploaded_file.name
        ):
            master_df = load_barcode_master_from_bytes(file_bytes, uploaded_file.name)

            st.session_state.barcode_lookup = {
                clean_barcode(row["Barcode"]): (
                    str(row["Item Number"]).strip(),
                    str(row["Description"]).strip(),
                )
                for _, row in master_df.iterrows()
            }
            st.session_state.master_loaded = True
            st.session_state.master_file_hash = current_hash
            st.session_state.master_file_name = uploaded_file.name

        st.success(
            f"Loaded barcode master: {st.session_state.master_file_name} ({len(st.session_state.barcode_lookup)} items)"
        )
    except Exception as e:
        st.session_state.master_loaded = False
        st.session_state.barcode_lookup = {}
        st.error(f"Failed to load barcode master: {e}")

if st.session_state.save_message:
    st.success(st.session_state.save_message)
    st.session_state.save_message = ""


# =========================================================
# Form
# =========================================================
with st.form("expiry_form", clear_on_submit=False):
    pd_user = st.text_input("PD/User Name:", key="form_pd_user")
    store_location = st.text_input("Store / Location:", key="form_store_location")
    barcode = st.text_input("Product Barcode:", key="form_barcode")
    qty = st.number_input("Quantity:", min_value=1.0, step=1.0, key="form_qty")
    expiry_date = st.date_input("Expiry Date:", key="form_expiry_date")
    remarks = st.text_input("Remarks:", key="form_remarks", placeholder="Optional remarks")

    col1, col2 = st.columns(2)
    with col1:
        submit = st.form_submit_button("Submit", use_container_width=True)
    with col2:
        export_inside_form = st.form_submit_button("Export", use_container_width=True)


# =========================================================
# Submit logic
# =========================================================
if submit:
    if not st.session_state.master_loaded:
        st.warning("Please upload barcode master first.")
    elif not pd_user.strip():
        st.warning("Please enter PD/User Name.")
    elif not store_location.strip():
        st.warning("Please enter Store / Location.")
    elif not clean_barcode(barcode):
        st.warning("Please scan barcode.")
    else:
        clean_code = clean_barcode(barcode)
        item_number, description = st.session_state.barcode_lookup.get(
            clean_code, ("", "Barcode not found in master")
        )

        today = date.today()
        status, days_left, action_required = get_status(expiry_date, today)

        st.session_state.rows.append({
            "PD/User Name": pd_user.strip(),
            "Store / Location": store_location.strip(),
            "Barcode": clean_code,
            "Item Number": item_number,
            "Description": description,
            "Qty": qty,
            "Expiry Date": expiry_date,
            "Status": status,
            "Days Left": days_left,
            "Scan Date": today,
            "Action Required": action_required,
            "Remarks": remarks.strip(),
        })

        st.session_state.save_message = f"Saved: {clean_code}"
        st.session_state.reset_scan_fields = True
        st.rerun()


# =========================================================
# Table + export
# =========================================================
if st.session_state.rows:
    df = pd.DataFrame(st.session_state.rows)
    st.dataframe(df, use_container_width=True, hide_index=True)

    excel_file = to_excel(df)

    st.download_button(
        "Download Excel Report",
        data=excel_file,
        file_name=f"expiry_report_{date.today().strftime('%Y%m%d')}.xlsx",
        mime="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        use_container_width=True,
    )

    csv_data = df.to_csv(index=False).encode("utf-8")
    st.download_button(
        "Download CSV",
        data=csv_data,
        file_name=f"expiry_report_{date.today().strftime('%Y%m%d')}.csv",
        mime="text/csv",
        use_container_width=True,
    )

    if export_inside_form:
        st.info("Use the Download Excel Report button below.")
else:
    if export_inside_form:
        st.warning("No data to export yet.")

st.markdown("---")

col_a, col_b = st.columns(2)
with col_a:
    if st.button("Clear Saved Lines", use_container_width=True):
        st.session_state.rows = []
        st.rerun()

with col_b:
    if st.button("Clear Barcode Master", use_container_width=True):
        st.session_state.barcode_lookup = {}
        st.session_state.master_loaded = False
        st.session_state.master_file_hash = ""
        st.session_state.master_file_name = ""
        st.rerun()