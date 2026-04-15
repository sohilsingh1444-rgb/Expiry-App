import io
from datetime import date

import pandas as pd
import streamlit as st

st.set_page_config(page_title="Expiry Scan App", layout="centered")


# -----------------------------
# Helpers
# -----------------------------
def normalize_columns(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    df.columns = [str(c).strip() for c in df.columns]
    return df


def find_column(columns, candidates):
    normalized = {str(c).strip().lower().replace('.', '').replace('_', ' '): c for c in columns}
    for cand in candidates:
        key = cand.strip().lower().replace('.', '').replace('_', ' ')
        if key in normalized:
            return normalized[key]
    return None


def prepare_barcode_master(df: pd.DataFrame) -> pd.DataFrame:
    df = normalize_columns(df)

    barcode_col = find_column(
        df.columns,
        ["barcode", "barcode no", "bar code", "ean", "upc", "item barcode", "barcode number", "code"],
    )
    item_col = find_column(
        df.columns,
        ["item no", "item number", "item_no", "item", "no", "item code"],
    )
    desc_col = find_column(
        df.columns,
        ["description", "item description", "desc", "product description", "retail item"],
    )

    if barcode_col is None:
        raise ValueError(
            "Barcode column not found in barcode master. Use a column like Barcode / Barcode No. / EAN / UPC / Item Barcode."
        )

    if item_col is None:
        df["__item_number"] = ""
        item_col = "__item_number"

    if desc_col is None:
        df["__description"] = ""
        desc_col = "__description"

    out = df[[barcode_col, item_col, desc_col]].copy()
    out.columns = ["Barcode", "Item Number", "Description"]
    out["Barcode"] = out["Barcode"].astype(str).str.strip()
    out["Item Number"] = out["Item Number"].fillna("").astype(str).str.strip()
    out["Description"] = out["Description"].fillna("").astype(str).str.strip()
    out = out[out["Barcode"] != ""]
    out = out.drop_duplicates(subset=["Barcode"], keep="first")
    return out


def get_expiry_status(expiry_date: date, today: date, near_days: int) -> str:
    if expiry_date < today:
        return "Expired"
    days_left = (expiry_date - today).days
    if days_left <= near_days:
        return "Near Expiry"
    return "OK"


def to_excel(raw_df: pd.DataFrame, summary_df: pd.DataFrame) -> bytes:
    output = io.BytesIO()
    with pd.ExcelWriter(output, engine="xlsxwriter", datetime_format="dd/mm/yyyy", date_format="dd/mm/yyyy") as writer:
        raw_df.to_excel(writer, index=False, sheet_name="Raw Report")
        summary_df.to_excel(writer, index=False, sheet_name="Summary")

        workbook = writer.book
        header_fmt = workbook.add_format({"bold": True, "border": 1, "align": "center", "valign": "vcenter"})
        date_fmt = workbook.add_format({"num_format": "dd/mm/yyyy"})
        expired_fmt = workbook.add_format({"bg_color": "#FFC7CE"})
        near_fmt = workbook.add_format({"bg_color": "#FFEB9C"})
        ok_fmt = workbook.add_format({"bg_color": "#C6EFCE"})

        for sheet_name, df in {"Raw Report": raw_df, "Summary": summary_df}.items():
            ws = writer.sheets[sheet_name]
            for col_num, value in enumerate(df.columns):
                ws.write(0, col_num, value, header_fmt)
                series = df.iloc[:, col_num].astype(str)
                max_len = max([len(str(value))] + series.map(len).tolist()) if len(series) else len(str(value))
                ws.set_column(col_num, col_num, min(max(max_len + 2, 12), 34))
            ws.freeze_panes(1, 0)

        raw_ws = writer.sheets["Raw Report"]
        if "Expiry Date" in raw_df.columns:
            idx = raw_df.columns.get_loc("Expiry Date")
            raw_ws.set_column(idx, idx, 14, date_fmt)
        if "Scan Date" in raw_df.columns:
            idx = raw_df.columns.get_loc("Scan Date")
            raw_ws.set_column(idx, idx, 14, date_fmt)
        if "Status" in raw_df.columns and len(raw_df) > 0:
            status_idx = raw_df.columns.get_loc("Status")
            raw_ws.conditional_format(1, status_idx, len(raw_df), status_idx, {
                "type": "text",
                "criteria": "containing",
                "value": "Expired",
                "format": expired_fmt,
            })
            raw_ws.conditional_format(1, status_idx, len(raw_df), status_idx, {
                "type": "text",
                "criteria": "containing",
                "value": "Near Expiry",
                "format": near_fmt,
            })
            raw_ws.conditional_format(1, status_idx, len(raw_df), status_idx, {
                "type": "text",
                "criteria": "containing",
                "value": "OK",
                "format": ok_fmt,
            })

    output.seek(0)
    return output.getvalue()


@st.cache_data(show_spinner=False)
def load_master_file(file_bytes: bytes, file_name: str) -> pd.DataFrame:
    if file_name.lower().endswith(".csv"):
        try:
            df = pd.read_csv(io.BytesIO(file_bytes))
        except UnicodeDecodeError:
            df = pd.read_csv(io.BytesIO(file_bytes), encoding="latin1")
    else:
        df = pd.read_excel(io.BytesIO(file_bytes))
    return prepare_barcode_master(df)


@st.cache_data(show_spinner=False)
def build_lookup(master_df: pd.DataFrame):
    return {
        str(row["Barcode"]).strip(): (
            str(row["Item Number"]).strip(),
            str(row["Description"]).strip(),
        )
        for _, row in master_df.iterrows()
    }


# -----------------------------
# Session state
# -----------------------------
if "scan_rows" not in st.session_state:
    st.session_state.scan_rows = []
if "barcode_master" not in st.session_state:
    st.session_state.barcode_master = None
if "barcode_lookup" not in st.session_state:
    st.session_state.barcode_lookup = {}
if "master_name" not in st.session_state:
    st.session_state.master_name = ""
if "message" not in st.session_state:
    st.session_state.message = ""
if "message_type" not in st.session_state:
    st.session_state.message_type = "success"


# -----------------------------
# Style
# -----------------------------
st.markdown(
    """
    <style>
    .stApp {
        background: #dfe6f1;
    }
    .block-container {
        max-width: 760px;
        margin-top: 1.5rem;
        margin-bottom: 2rem;
        padding-top: 2rem;
        padding-bottom: 2rem;
        padding-left: 1.2rem;
        padding-right: 1.2rem;
        background: white;
        border-radius: 16px;
        box-shadow: 0 10px 25px rgba(0,0,0,0.08);
    }
    h1 {
        text-align: center;
        margin-bottom: 1.2rem;
    }
    .small-box {
        padding: 0.75rem 0.9rem;
        border-radius: 10px;
        background: #f5f7fb;
        border: 1px solid #d9e0ea;
        margin-bottom: 0.7rem;
        font-size: 1.02rem;
    }
    .master-box {
        padding: 0.7rem 0.9rem;
        border-radius: 10px;
        background: #eef7ee;
        border: 1px solid #cfe7cf;
        margin-bottom: 0.9rem;
    }
    </style>
    """,
    unsafe_allow_html=True,
)

st.title("Expiry Scan App")
near_expiry_days = 30

if st.session_state.message:
    if st.session_state.message_type == "success":
        st.success(st.session_state.message)
    elif st.session_state.message_type == "warning":
        st.warning(st.session_state.message)
    else:
        st.error(st.session_state.message)
    st.session_state.message = ""

# -----------------------------
# Barcode master upload
# -----------------------------
st.markdown("**Upload Barcode Master (Excel or CSV format):**")
master_file = st.file_uploader("", type=["xlsx", "xls", "csv"], label_visibility="collapsed")

if master_file is not None:
    file_bytes = master_file.getvalue()
    file_name = master_file.name
    if st.session_state.master_name != file_name:
        try:
            st.session_state.barcode_master = load_master_file(file_bytes, file_name)
            st.session_state.barcode_lookup = build_lookup(st.session_state.barcode_master)
            st.session_state.master_name = file_name
            st.session_state.message = f"Barcode master loaded: {len(st.session_state.barcode_master)} items"
            st.session_state.message_type = "success"
            st.rerun()
        except Exception as e:
            st.session_state.message = f"Failed to load barcode master: {e}"
            st.session_state.message_type = "error"
            st.rerun()

if st.session_state.master_name:
    st.markdown(
        f'<div class="master-box"><b>Saved Barcode Master:</b> {st.session_state.master_name}</div>',
        unsafe_allow_html=True,
    )
    if st.button("Clear Saved Barcode Master", use_container_width=True):
        st.session_state.barcode_master = None
        st.session_state.barcode_lookup = {}
        st.session_state.master_name = ""
        st.session_state.message = "Saved barcode master cleared."
        st.session_state.message_type = "success"
        st.rerun()


# -----------------------------
# Main form
# -----------------------------
with st.form("scan_form", clear_on_submit=True):
    scanned_by = st.text_input("PD/User Name:", placeholder="Enter user name")
    store_location = st.text_input("Store / Location:", placeholder="Enter store or location")
    barcode = st.text_input("Product Barcode:", placeholder="Scan barcode here")

    item_number = ""
    description = ""
    if barcode.strip() and st.session_state.barcode_lookup:
        item_number, description = st.session_state.barcode_lookup.get(
            barcode.strip(), ("", "Barcode not found in master")
        )

    if item_number:
        st.markdown(f'<div class="small-box"><b>Item Number:</b> {item_number}</div>', unsafe_allow_html=True)
    if description:
        st.markdown(f'<div class="small-box"><b>Description:</b> {description}</div>', unsafe_allow_html=True)

    qty = st.number_input("Quantity:", min_value=0.0, value=1.0, step=1.0)
    expiry_date = st.date_input("Expiry Date:", value=date.today())
    remarks = st.text_input("Remarks:", placeholder="Optional remarks")

    submitted = st.form_submit_button("Submit", use_container_width=True)

if submitted:
    if not st.session_state.barcode_lookup:
        st.session_state.message = "Please upload barcode master first."
        st.session_state.message_type = "warning"
    elif not scanned_by.strip():
        st.session_state.message = "Please enter PD/User Name."
        st.session_state.message_type = "warning"
    elif not store_location.strip():
        st.session_state.message = "Please enter Store / Location."
        st.session_state.message_type = "warning"
    elif not barcode.strip():
        st.session_state.message = "Please scan barcode."
        st.session_state.message_type = "warning"
    elif qty <= 0:
        st.session_state.message = "Quantity must be more than 0."
        st.session_state.message_type = "warning"
    else:
        item_number, description = st.session_state.barcode_lookup.get(
            barcode.strip(), ("", "Barcode not found in master")
        )
        today = date.today()
        st.session_state.scan_rows.append(
            {
                "PD/User Name": scanned_by.strip(),
                "Store / Location": store_location.strip(),
                "Barcode": barcode.strip(),
                "Item Number": item_number,
                "Description": description,
                "Qty": qty,
                "Expiry Date": expiry_date,
                "Status": get_expiry_status(expiry_date, today, near_expiry_days),
                "Days Left": (expiry_date - today).days,
                "Scan Date": today,
                "Remarks": remarks.strip(),
            }
        )
        st.session_state.message = "Data saved successfully!"
        st.session_state.message_type = "success"
        st.rerun()


# -----------------------------
# Saved lines and export
# -----------------------------
raw_df = pd.DataFrame(st.session_state.scan_rows)

if not raw_df.empty:
    st.markdown("### Saved Lines")
    st.dataframe(raw_df.tail(20), use_container_width=True, hide_index=True)

    col1, col2 = st.columns(2)
    with col1:
        if st.button("Clear Saved Lines", use_container_width=True):
            st.session_state.scan_rows = []
            st.session_state.message = "Saved lines cleared."
            st.session_state.message_type = "success"
            st.rerun()
    with col2:
        summary_df = (
            raw_df.groupby(["Store / Location", "Item Number", "Description", "Status"], dropna=False, as_index=False)
            .agg(
                Total_Qty=("Qty", "sum"),
                Lines=("Barcode", "count"),
                Earliest_Expiry=("Expiry Date", "min"),
                Latest_Expiry=("Expiry Date", "max"),
            )
            .sort_values(["Store / Location", "Status", "Description"], kind="stable")
        )
        st.download_button(
            label="Export",
            data=to_excel(raw_df, summary_df),
            file_name=f"expiry_report_{date.today().strftime('%Y%m%d')}.xlsx",
            mime="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            use_container_width=True,
        )
else:
    st.button("Export", use_container_width=True, disabled=True)