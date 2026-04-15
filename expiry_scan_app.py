import io
from datetime import date
from pathlib import Path

import pandas as pd
import streamlit as st

st.set_page_config(page_title="Expiry Scan App", layout="centered")

MASTER_FILE = Path("saved_barcode_master.xlsx")


# -----------------------------
# Helpers
# -----------------------------
def normalize_columns(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    df.columns = [str(c).strip() for c in df.columns]
    return df


def find_column(columns, candidates):
    normalized = {str(c).strip().lower().replace(".", "").replace("_", " "): c for c in columns}
    for cand in candidates:
        key = cand.strip().lower().replace(".", "").replace("_", " ")
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
        df["__item_number"] = "UNKNOWN"
        item_col = "__item_number"

    if desc_col is None:
        df["__description"] = "UNKNOWN ITEM"
        desc_col = "__description"

    out = df[[barcode_col, item_col, desc_col]].copy()
    out.columns = ["Barcode", "Item Number", "Description"]
    out["Barcode"] = out["Barcode"].astype(str).str.strip()
    out["Item Number"] = out["Item Number"].fillna("UNKNOWN").astype(str).str.strip()
    out["Description"] = out["Description"].fillna("UNKNOWN ITEM").astype(str).str.strip()

    out.loc[out["Item Number"].isin(["", "nan", "None"]), "Item Number"] = "UNKNOWN"
    out.loc[out["Description"].isin(["", "nan", "None"]), "Description"] = "UNKNOWN ITEM"

    out = out[out["Barcode"] != ""]
    out = out.drop_duplicates(subset=["Barcode"], keep="first")
    return out


def load_saved_barcode_master():
    if MASTER_FILE.exists():
        df = pd.read_excel(MASTER_FILE)
        return prepare_barcode_master(df)
    return None


def save_barcode_master_file(uploaded_file):
    if uploaded_file.name.lower().endswith(".csv"):
        try:
            df = pd.read_csv(uploaded_file)
        except UnicodeDecodeError:
            uploaded_file.seek(0)
            df = pd.read_csv(uploaded_file, encoding="latin1")
    else:
        df = pd.read_excel(uploaded_file)

    with pd.ExcelWriter(MASTER_FILE, engine="openpyxl") as writer:
        df.to_excel(writer, index=False)

    return prepare_barcode_master(df)


def get_expiry_status(expiry_date: date, today: date, near_days: int) -> str:
    if expiry_date < today:
        return "Expired"
    days_left = (expiry_date - today).days
    if days_left <= near_days:
        return "Near Expiry"
    return "OK"


def get_action_required(days_left: int, status: str) -> str:
    if status == "Expired":
        return "Remove immediately"
    if days_left < 3:
        return "Urgent action"
    if days_left < 7:
        return "Monitor / markdown"
    if status == "Near Expiry":
        return "Check and plan"
    return "No action"


def to_excel(raw_df: pd.DataFrame, summary_df: pd.DataFrame, near_expiry_days: int) -> bytes:
    output = io.BytesIO()

    raw_export = raw_df.copy()
    summary_export = summary_df.copy()

    with pd.ExcelWriter(output, engine="xlsxwriter", datetime_format="dd/mm/yyyy", date_format="dd/mm/yyyy") as writer:
        raw_export.to_excel(writer, index=False, sheet_name="Raw Report")
        summary_export.to_excel(writer, index=False, sheet_name="Summary")

        workbook = writer.book
        raw_ws = writer.sheets["Raw Report"]
        summary_ws = writer.sheets["Summary"]

        header_fmt = workbook.add_format({
            "bold": True,
            "border": 1,
            "align": "center",
            "valign": "vcenter"
        })
        date_fmt = workbook.add_format({"num_format": "dd/mm/yyyy"})
        red_fmt = workbook.add_format({"bg_color": "#FFC7CE"})
        yellow_fmt = workbook.add_format({"bg_color": "#FFEB9C"})
        green_fmt = workbook.add_format({"bg_color": "#C6EFCE"})

        for sheet_name, df in {"Raw Report": raw_export, "Summary": summary_export}.items():
            ws = writer.sheets[sheet_name]
            for col_num, value in enumerate(df.columns):
                ws.write(0, col_num, value, header_fmt)
                series = df.iloc[:, col_num].astype(str)
                max_len = max([len(str(value))] + series.map(len).tolist()) if len(series) else len(str(value))
                ws.set_column(col_num, col_num, min(max(max_len + 2, 12), 30))
            ws.freeze_panes(1, 0)

        if "Expiry Date" in raw_export.columns:
            idx = raw_export.columns.get_loc("Expiry Date")
            raw_ws.set_column(idx, idx, 14, date_fmt)

        if "Scan Date" in raw_export.columns:
            idx = raw_export.columns.get_loc("Scan Date")
            raw_ws.set_column(idx, idx, 14, date_fmt)

        if "Earliest_Expiry" in summary_export.columns:
            idx = summary_export.columns.get_loc("Earliest_Expiry")
            summary_ws.set_column(idx, idx, 14, date_fmt)

        if "Latest_Expiry" in summary_export.columns:
            idx = summary_export.columns.get_loc("Latest_Expiry")
            summary_ws.set_column(idx, idx, 14, date_fmt)

        if not raw_export.empty:
            expiry_idx = raw_export.columns.get_loc("Expiry Date")
            status_idx = raw_export.columns.get_loc("Status")
            days_idx = raw_export.columns.get_loc("Days Left")
            action_idx = raw_export.columns.get_loc("Action Required")

            def col_letter(col_num):
                result = ""
                col_num += 1
                while col_num > 0:
                    col_num, remainder = divmod(col_num - 1, 26)
                    result = chr(65 + remainder) + result
                return result

            expiry_col_letter = col_letter(expiry_idx)

            for i in range(len(raw_export)):
                excel_row = i + 1
                excel_row_1based = excel_row + 1

                raw_ws.write_formula(
                    excel_row,
                    days_idx,
                    f"=INT({expiry_col_letter}{excel_row_1based}-TODAY())"
                )

                raw_ws.write_formula(
                    excel_row,
                    status_idx,
                    (
                        f'=IF({expiry_col_letter}{excel_row_1based}<TODAY(),"Expired",'
                        f'IF(INT({expiry_col_letter}{excel_row_1based}-TODAY())<={near_expiry_days},"Near Expiry","OK"))'
                    )
                )

                raw_ws.write_formula(
                    excel_row,
                    action_idx,
                    (
                        f'=IF({expiry_col_letter}{excel_row_1based}<TODAY(),"Remove immediately",'
                        f'IF(INT({expiry_col_letter}{excel_row_1based}-TODAY())<3,"Urgent action",'
                        f'IF(INT({expiry_col_letter}{excel_row_1based}-TODAY())<7,"Monitor / markdown",'
                        f'IF(INT({expiry_col_letter}{excel_row_1based}-TODAY())<={near_expiry_days},"Check and plan","No action"))))'
                    )
                )

        if "Status" in raw_export.columns and len(raw_export) > 0:
            status_idx = raw_export.columns.get_loc("Status")
            raw_ws.conditional_format(1, status_idx, len(raw_export), status_idx, {
                "type": "text",
                "criteria": "containing",
                "value": "Expired",
                "format": red_fmt,
            })
            raw_ws.conditional_format(1, status_idx, len(raw_export), status_idx, {
                "type": "text",
                "criteria": "containing",
                "value": "Near Expiry",
                "format": yellow_fmt,
            })
            raw_ws.conditional_format(1, status_idx, len(raw_export), status_idx, {
                "type": "text",
                "criteria": "containing",
                "value": "OK",
                "format": green_fmt,
            })

        if "Days Left" in raw_export.columns and len(raw_export) > 0:
            days_idx = raw_export.columns.get_loc("Days Left")
            raw_ws.conditional_format(1, days_idx, len(raw_export), days_idx, {
                "type": "cell",
                "criteria": "<",
                "value": 3,
                "format": red_fmt,
            })
            raw_ws.conditional_format(1, days_idx, len(raw_export), days_idx, {
                "type": "cell",
                "criteria": "between",
                "minimum": 3,
                "maximum": 6,
                "format": yellow_fmt,
            })
            raw_ws.conditional_format(1, days_idx, len(raw_export), days_idx, {
                "type": "cell",
                "criteria": ">=",
                "value": 7,
                "format": green_fmt,
            })

        if "Action Required" in raw_export.columns and len(raw_export) > 0:
            action_idx = raw_export.columns.get_loc("Action Required")
            raw_ws.conditional_format(1, action_idx, len(raw_export), action_idx, {
                "type": "text",
                "criteria": "containing",
                "value": "Remove immediately",
                "format": red_fmt,
            })
            raw_ws.conditional_format(1, action_idx, len(raw_export), action_idx, {
                "type": "text",
                "criteria": "containing",
                "value": "Urgent action",
                "format": red_fmt,
            })
            raw_ws.conditional_format(1, action_idx, len(raw_export), action_idx, {
                "type": "text",
                "criteria": "containing",
                "value": "Monitor / markdown",
                "format": yellow_fmt,
            })
            raw_ws.conditional_format(1, action_idx, len(raw_export), action_idx, {
                "type": "text",
                "criteria": "containing",
                "value": "Check and plan",
                "format": yellow_fmt,
            })
            raw_ws.conditional_format(1, action_idx, len(raw_export), action_idx, {
                "type": "text",
                "criteria": "containing",
                "value": "No action",
                "format": green_fmt,
            })

        if "Item Number" in raw_export.columns and len(raw_export) > 0:
            item_idx = raw_export.columns.get_loc("Item Number")
            raw_ws.conditional_format(1, item_idx, len(raw_export), item_idx, {
                "type": "text",
                "criteria": "containing",
                "value": "UNKNOWN",
                "format": red_fmt,
            })

        if "Description" in raw_export.columns and len(raw_export) > 0:
            desc_idx = raw_export.columns.get_loc("Description")
            raw_ws.conditional_format(1, desc_idx, len(raw_export), desc_idx, {
                "type": "text",
                "criteria": "containing",
                "value": "UNKNOWN ITEM",
                "format": red_fmt,
            })

    output.seek(0)
    return output.getvalue()


# -----------------------------
# Session state
# -----------------------------
if "scan_rows" not in st.session_state:
    st.session_state.scan_rows = []

if "barcode_master" not in st.session_state:
    st.session_state.barcode_master = load_saved_barcode_master()


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
        margin-top: 2rem;
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
    div[data-testid="stFileUploader"] section {
        padding: 0.7rem;
    }
    .small-box {
        padding: 0.65rem 0.85rem;
        border-radius: 10px;
        background: #f5f7fb;
        border: 1px solid #d9e0ea;
        margin-bottom: 0.7rem;
    }
    </style>
    """,
    unsafe_allow_html=True,
)

st.title("Expiry Scan App")

near_expiry_days = 30

# -----------------------------
# Barcode master upload
# -----------------------------
st.markdown("**Upload Barcode Master (Excel or CSV format):**")
master_file = st.file_uploader("", type=["xlsx", "xls", "csv"], label_visibility="collapsed")

if master_file is not None:
    try:
        st.session_state.barcode_master = save_barcode_master_file(master_file)
        st.success(f"Barcode master loaded and saved: {len(st.session_state.barcode_master)} items")
    except Exception as e:
        st.error(f"Failed to load barcode master: {e}")
elif st.session_state.barcode_master is not None:
    st.success(f"Saved barcode master already loaded: {len(st.session_state.barcode_master)} items")
else:
    st.warning("Please upload barcode master once.")

col1, col2 = st.columns(2)
with col1:
    if st.button("Clear Saved Barcode Master", use_container_width=True):
        if MASTER_FILE.exists():
            MASTER_FILE.unlink()
        st.session_state.barcode_master = None
        st.success("Saved barcode master removed.")
with col2:
    st.empty()

# -----------------------------
# Inputs
# -----------------------------
scanned_by = st.text_input("PD/User Name:", placeholder="Enter user name")
store_location = st.text_input("Store / Location:", placeholder="Enter store or location")
barcode = st.text_input("Product Barcode:", placeholder="Scan barcode here")

item_number = ""
description = ""

if barcode and st.session_state.barcode_master is not None:
    match = st.session_state.barcode_master[
        st.session_state.barcode_master["Barcode"].astype(str).str.strip() == str(barcode).strip()
    ]

    if not match.empty:
        item_number = str(match.iloc[0]["Item Number"]).strip()
        description = str(match.iloc[0]["Description"]).strip()

        if item_number == "" or item_number.lower() == "nan":
            item_number = "UNKNOWN"

        if description == "" or description.lower() == "nan":
            description = "UNKNOWN ITEM"
    else:
        item_number = "UNKNOWN"
        description = "UNKNOWN ITEM"

if item_number:
    st.markdown(f'<div class="small-box"><b>Item Number:</b> {item_number}</div>', unsafe_allow_html=True)
if description:
    st.markdown(f'<div class="small-box"><b>Description:</b> {description}</div>', unsafe_allow_html=True)

qty = st.number_input("Quantity:", min_value=0.0, value=1.0, step=1.0)
expiry_date = st.date_input("Expiry Date:", value=date.today())
remarks = st.text_input("Remarks:", placeholder="Optional remarks")

# -----------------------------
# Submit
# -----------------------------
if st.button("Submit", use_container_width=True):
    if st.session_state.barcode_master is None:
        st.warning("Please upload barcode master first.")
    elif not scanned_by.strip():
        st.warning("Please enter PD/User Name.")
    elif not store_location.strip():
        st.warning("Please enter Store / Location.")
    elif not str(barcode).strip():
        st.warning("Please scan barcode.")
    elif qty <= 0:
        st.warning("Quantity must be more than 0.")
    else:
        today = date.today()
        status = get_expiry_status(expiry_date, today, near_expiry_days)
        days_left = (expiry_date - today).days

        st.session_state.scan_rows.append(
            {
                "PD/User Name": scanned_by.strip(),
                "Store / Location": store_location.strip(),
                "Barcode": str(barcode).strip(),
                "Item Number": item_number,
                "Description": description,
                "Qty": qty,
                "Expiry Date": expiry_date,
                "Status": status,
                "Days Left": days_left,
                "Scan Date": today,
                "Action Required": get_action_required(days_left, status),
                "Remarks": remarks.strip(),
            }
        )
        st.success("Data saved successfully!")

# -----------------------------
# Show saved lines
# -----------------------------
raw_df = pd.DataFrame(st.session_state.scan_rows)
if not raw_df.empty:
    st.markdown("### Saved Lines")
    st.dataframe(raw_df, use_container_width=True, hide_index=True)

# -----------------------------
# Export
# -----------------------------
if st.button("Export", use_container_width=True):
    raw_df = pd.DataFrame(st.session_state.scan_rows)
    if raw_df.empty:
        st.warning("No data to export.")
    else:
        summary_df = (
            raw_df.groupby(
                ["Store / Location", "Item Number", "Description", "Status", "Action Required"],
                dropna=False,
                as_index=False
            )
            .agg(
                Total_Qty=("Qty", "sum"),
                Lines=("Barcode", "count"),
                Earliest_Expiry=("Expiry Date", "min"),
                Latest_Expiry=("Expiry Date", "max"),
            )
            .sort_values(["Store / Location", "Status", "Description"], kind="stable")
        )

        file_name = f"expiry_report_{scanned_by.strip() or 'user'}.xlsx"
        st.download_button(
            label="Download Excel Report",
            data=to_excel(raw_df, summary_df, near_expiry_days),
            file_name=file_name,
            mime="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            use_container_width=True,
        )