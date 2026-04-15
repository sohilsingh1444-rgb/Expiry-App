import io
import re
from datetime import date, datetime

import pandas as pd
import streamlit as st
import streamlit.components.v1 as components

st.set_page_config(page_title="Expiry Scan App", layout="wide")


# =========================================================
# Helpers
# =========================================================
def normalize_columns(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    df.columns = [str(c).strip() for c in df.columns]
    return df


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


def clean_barcode(value) -> str:
    if value is None or (isinstance(value, float) and pd.isna(value)):
        return ""

    s = str(value).strip()
    if not s:
        return ""

    s = s.replace("\n", "").replace("\r", "").replace("\t", "").strip()
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


def prepare_barcode_master(df: pd.DataFrame) -> pd.DataFrame:
    df = normalize_columns(df)

    barcode_col = find_column(
        df.columns,
        [
            "barcode",
            "barcode no",
            "bar code",
            "ean",
            "upc",
            "item barcode",
            "barcode number",
            "code",
        ],
    )
    item_col = find_column(
        df.columns,
        ["item no", "item number", "item_no", "item", "no", "item code"],
    )
    desc_col = find_column(
        df.columns,
        [
            "description",
            "item description",
            "desc",
            "product description",
            "retail item",
        ],
    )

    if barcode_col is None:
        raise ValueError(
            "Barcode column not found. Use a column like Barcode / Barcode No / EAN / UPC / Item Barcode."
        )

    if item_col is None:
        df["__item_number"] = ""
        item_col = "__item_number"

    if desc_col is None:
        df["__description"] = ""
        desc_col = "__description"

    out = df[[barcode_col, item_col, desc_col]].copy()
    out.columns = ["Barcode", "Item Number", "Description"]

    out["Barcode"] = out["Barcode"].apply(clean_barcode)
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


def get_action_required(status: str, days_left: int) -> str:
    if status == "Expired":
        return "Remove immediately"
    if status == "Near Expiry":
        return "Check / markdown / rotate"
    return "No action"


@st.cache_data(show_spinner=False)
def load_master_file(file_bytes: bytes, file_name: str) -> pd.DataFrame:
    if file_name.lower().endswith(".csv"):
        try:
            df = pd.read_csv(io.BytesIO(file_bytes), dtype=str)
        except UnicodeDecodeError:
            df = pd.read_csv(io.BytesIO(file_bytes), dtype=str, encoding="latin1")
    else:
        df = pd.read_excel(io.BytesIO(file_bytes), dtype=str)

    return prepare_barcode_master(df)


@st.cache_data(show_spinner=False)
def build_lookup(master_df: pd.DataFrame):
    return {
        clean_barcode(row["Barcode"]): (
            str(row["Item Number"]).strip(),
            str(row["Description"]).strip(),
        )
        for _, row in master_df.iterrows()
    }


def focus_barcode_input():
    components.html(
        """
        <script>
        const tryFocus = () => {
          const inputs = window.parent.document.querySelectorAll('input');
          for (const el of inputs) {
            const aria = (el.getAttribute('aria-label') || '').toLowerCase();
            const placeholder = (el.getAttribute('placeholder') || '').toLowerCase();
            if (aria.includes('product barcode') || placeholder.includes('scan barcode')) {
              el.focus();
              el.select();
              break;
            }
          }
        };
        setTimeout(tryFocus, 150);
        setTimeout(tryFocus, 500);
        </script>
        """,
        height=0,
    )


def show_message():
    msg = st.session_state.get("message", "")
    msg_type = st.session_state.get("message_type", "success")

    if msg:
        if msg_type == "success":
            st.success(msg)
        elif msg_type == "warning":
            st.warning(msg)
        else:
            st.error(msg)

        st.session_state.message = ""


def reset_entry_fields():
    st.session_state.barcode_input = ""
    st.session_state.remarks_input = ""
    st.session_state.qty_input = 1.0
    st.session_state.last_lookup_item = ""
    st.session_state.last_lookup_desc = ""
    st.session_state.focus_barcode = True


def lookup_current_barcode():
    barcode = clean_barcode(st.session_state.get("barcode_input", ""))
    if not barcode:
        st.session_state.last_lookup_item = ""
        st.session_state.last_lookup_desc = ""
        return

    item_number, description = st.session_state.barcode_lookup.get(
        barcode, ("", "Barcode not found in master")
    )
    st.session_state.last_lookup_item = item_number
    st.session_state.last_lookup_desc = description


def add_scan_row():
    if not st.session_state.barcode_lookup:
        st.session_state.message = "Please upload barcode master first."
        st.session_state.message_type = "warning"
        return

    scanned_by = st.session_state.get("fixed_user", "").strip()
    store_location = st.session_state.get("fixed_store", "").strip()
    barcode = clean_barcode(st.session_state.get("barcode_input", ""))
    qty = float(st.session_state.get("qty_input", 1.0))
    expiry_date = st.session_state.get("expiry_input", date.today())
    remarks = st.session_state.get("remarks_input", "").strip()
    near_expiry_days = int(st.session_state.get("near_expiry_days", 30))

    if not scanned_by:
        st.session_state.message = "Please enter PD/User Name in the sidebar."
        st.session_state.message_type = "warning"
        return

    if not store_location:
        st.session_state.message = "Please enter Store / Location in the sidebar."
        st.session_state.message_type = "warning"
        return

    if not barcode:
        st.session_state.message = "Please scan barcode."
        st.session_state.message_type = "warning"
        return

    if qty <= 0:
        st.session_state.message = "Quantity must be more than 0."
        st.session_state.message_type = "warning"
        return

    item_number, description = st.session_state.barcode_lookup.get(
        barcode, ("", "Barcode not found in master")
    )

    today = date.today()
    days_left = (expiry_date - today).days
    status = get_expiry_status(expiry_date, today, near_expiry_days)
    action_required = get_action_required(status, days_left)

    st.session_state.scan_rows.append(
        {
            "PD/User Name": scanned_by,
            "Store / Location": store_location,
            "Barcode": barcode,
            "Item Number": item_number,
            "Description": description,
            "Qty": qty,
            "Expiry Date": expiry_date,
            "Status": status,
            "Days Left": days_left,
            "Scan Date": today,
            "Action Required": action_required,
            "Remarks": remarks,
        }
    )

    st.session_state.message = f"Saved: {barcode}"
    st.session_state.message_type = "success"
    reset_entry_fields()


def barcode_changed():
    lookup_current_barcode()


def make_summary(raw_df: pd.DataFrame) -> pd.DataFrame:
    if raw_df.empty:
        return pd.DataFrame()

    summary_df = (
        raw_df.groupby(
            ["Store / Location", "Item Number", "Description", "Status", "Action Required"],
            dropna=False,
            as_index=False,
        )
        .agg(
            Total_Qty=("Qty", "sum"),
            Lines=("Barcode", "count"),
            Earliest_Expiry=("Expiry Date", "min"),
            Latest_Expiry=("Expiry Date", "max"),
        )
        .sort_values(
            ["Store / Location", "Status", "Description"],
            kind="stable",
        )
    )

    return summary_df


def to_excel(raw_df: pd.DataFrame, summary_df: pd.DataFrame) -> bytes:
    output = io.BytesIO()

    with pd.ExcelWriter(
        output,
        engine="xlsxwriter",
        datetime_format="dd/mm/yyyy",
        date_format="dd/mm/yyyy",
    ) as writer:
        raw_df.to_excel(writer, index=False, sheet_name="Raw Report")
        summary_df.to_excel(writer, index=False, sheet_name="Summary")

        workbook = writer.book
        raw_ws = writer.sheets["Raw Report"]
        summary_ws = writer.sheets["Summary"]

        title_fmt = workbook.add_format(
            {
                "bold": True,
                "font_size": 14,
                "align": "center",
                "valign": "vcenter",
                "border": 1,
            }
        )
        header_fmt = workbook.add_format(
            {
                "bold": True,
                "text_wrap": True,
                "align": "center",
                "valign": "vcenter",
                "border": 1,
                "bg_color": "#D9EAF7",
            }
        )
        cell_fmt = workbook.add_format(
            {
                "border": 1,
                "valign": "vcenter",
            }
        )
        center_fmt = workbook.add_format(
            {
                "border": 1,
                "align": "center",
                "valign": "vcenter",
            }
        )
        date_fmt = workbook.add_format(
            {
                "num_format": "dd/mm/yyyy",
                "border": 1,
                "align": "center",
                "valign": "vcenter",
            }
        )
        qty_fmt = workbook.add_format(
            {
                "border": 1,
                "align": "center",
                "valign": "vcenter",
                "num_format": "0.00",
            }
        )
        barcode_text_fmt = workbook.add_format(
            {
                "border": 1,
                "num_format": "@",
                "align": "center",
                "valign": "vcenter",
            }
        )
        formula_center_fmt = workbook.add_format(
            {
                "border": 1,
                "align": "center",
                "valign": "vcenter",
            }
        )
        expired_fmt = workbook.add_format(
            {"bg_color": "#FFC7CE", "font_color": "#9C0006", "border": 1}
        )
        near_fmt = workbook.add_format(
            {"bg_color": "#FFEB9C", "font_color": "#9C6500", "border": 1}
        )
        ok_fmt = workbook.add_format(
            {"bg_color": "#C6EFCE", "font_color": "#006100", "border": 1}
        )

        raw_cols = list(raw_df.columns)
        raw_row_count = len(raw_df)

        raw_ws.insert_row(0)
        raw_ws.merge_range(
            0,
            0,
            0,
            max(len(raw_cols) - 1, 0),
            "Expiry Scan Report",
            title_fmt,
        )

        for col_num, col_name in enumerate(raw_cols):
            raw_ws.write(1, col_num, col_name, header_fmt)

        for row_num, row in raw_df.iterrows():
            excel_row = row_num + 2

            for col_num, col_name in enumerate(raw_cols):
                value = row[col_name]

                if col_name == "Barcode":
                    raw_ws.write_string(excel_row, col_num, clean_barcode(value), barcode_text_fmt)
                elif col_name in ["Expiry Date", "Scan Date"]:
                    raw_ws.write_datetime(
                        excel_row,
                        col_num,
                        datetime.combine(pd.to_datetime(value).date(), datetime.min.time()),
                        date_fmt,
                    )
                elif col_name == "Qty":
                    raw_ws.write_number(excel_row, col_num, float(value), qty_fmt)
                elif col_name == "Days Left":
                    expiry_col_letter = chr(65 + raw_cols.index("Expiry Date"))
                    raw_ws.write_formula(
                        excel_row,
                        col_num,
                        f"={expiry_col_letter}{excel_row+1}-TODAY()",
                        formula_center_fmt,
                    )
                elif col_name == "Status":
                    expiry_col_letter = chr(65 + raw_cols.index("Expiry Date"))
                    raw_ws.write_formula(
                        excel_row,
                        col_num,
                        (
                            f'=IF({expiry_col_letter}{excel_row+1}<TODAY(),"Expired",'
                            f'IF({expiry_col_letter}{excel_row+1}-TODAY()<='
                            f'{int(st.session_state.get("near_expiry_days", 30))},"Near Expiry","OK"))'
                        ),
                        center_fmt,
                    )
                elif col_name == "Action Required":
                    status_col_letter = chr(65 + raw_cols.index("Status"))
                    raw_ws.write_formula(
                        excel_row,
                        col_num,
                        (
                            f'=IF({status_col_letter}{excel_row+1}="Expired","Remove immediately",'
                            f'IF({status_col_letter}{excel_row+1}="Near Expiry","Check / markdown / rotate","No action"))'
                        ),
                        cell_fmt,
                    )
                else:
                    raw_ws.write(excel_row, col_num, value, cell_fmt)

        raw_ws.freeze_panes(2, 0)
        raw_ws.autofilter(1, 0, raw_row_count + 1, len(raw_cols) - 1)

        for col_num, col_name in enumerate(raw_cols):
            if col_name == "Barcode":
                width = 18
            elif col_name in ["Expiry Date", "Scan Date"]:
                width = 13
            elif col_name == "Status":
                width = 14
            elif col_name in ["Days Left", "Qty"]:
                width = 10
            elif col_name == "Action Required":
                width = 24
            elif col_name == "Description":
                width = 40
            elif col_name == "Remarks":
                width = 24
            else:
                width = max(14, min(24, len(col_name) + 4))
            raw_ws.set_column(col_num, col_num, width)

        raw_ws.set_row(0, 24)
        raw_ws.set_row(1, 24)

        if raw_row_count > 0 and "Status" in raw_cols:
            status_idx = raw_cols.index("Status")
            raw_ws.conditional_format(
                2,
                status_idx,
                raw_row_count + 1,
                status_idx,
                {
                    "type": "text",
                    "criteria": "containing",
                    "value": "Expired",
                    "format": expired_fmt,
                },
            )
            raw_ws.conditional_format(
                2,
                status_idx,
                raw_row_count + 1,
                status_idx,
                {
                    "type": "text",
                    "criteria": "containing",
                    "value": "Near Expiry",
                    "format": near_fmt,
                },
            )
            raw_ws.conditional_format(
                2,
                status_idx,
                raw_row_count + 1,
                status_idx,
                {
                    "type": "text",
                    "criteria": "containing",
                    "value": "OK",
                    "format": ok_fmt,
                },
            )

        if raw_row_count > 0 and "Status" in raw_cols:
            status_letter = chr(65 + raw_cols.index("Status"))
            raw_ws.conditional_format(
                2,
                0,
                raw_row_count + 1,
                len(raw_cols) - 1,
                {
                    "type": "formula",
                    "criteria": f'=${status_letter}3="Expired"',
                    "format": expired_fmt,
                },
            )
            raw_ws.conditional_format(
                2,
                0,
                raw_row_count + 1,
                len(raw_cols) - 1,
                {
                    "type": "formula",
                    "criteria": f'=${status_letter}3="Near Expiry"',
                    "format": near_fmt,
                },
            )

        raw_ws.repeat_rows(0, 1)
        raw_ws.fit_to_pages(1, 0)

        summary_cols = list(summary_df.columns)
        summary_row_count = len(summary_df)

        summary_ws.insert_row(0)
        summary_ws.merge_range(
            0,
            0,
            0,
            max(len(summary_cols) - 1, 0),
            "Expiry Summary",
            title_fmt,
        )

        for col_num, col_name in enumerate(summary_cols):
            summary_ws.write(1, col_num, col_name, header_fmt)

        for row_num, row in summary_df.iterrows():
            excel_row = row_num + 2
            for col_num, col_name in enumerate(summary_cols):
                value = row[col_name]
                if "Expiry" in col_name:
                    summary_ws.write_datetime(
                        excel_row,
                        col_num,
                        datetime.combine(pd.to_datetime(value).date(), datetime.min.time()),
                        date_fmt,
                    )
                elif col_name in ["Total_Qty", "Lines"]:
                    summary_ws.write_number(excel_row, col_num, float(value), qty_fmt)
                else:
                    summary_ws.write(excel_row, col_num, value, cell_fmt)

        summary_ws.freeze_panes(2, 0)
        summary_ws.autofilter(1, 0, summary_row_count + 1, len(summary_cols) - 1)

        for col_num, col_name in enumerate(summary_cols):
            if col_name == "Description":
                width = 40
            elif "Expiry" in col_name:
                width = 13
            elif col_name == "Status":
                width = 14
            elif col_name == "Action Required":
                width = 24
            else:
                width = max(14, min(22, len(col_name) + 4))
            summary_ws.set_column(col_num, col_num, width)

        summary_ws.set_row(0, 24)
        summary_ws.set_row(1, 24)
        summary_ws.repeat_rows(0, 1)
        summary_ws.fit_to_pages(1, 0)

    output.seek(0)
    return output.getvalue()


# =========================================================
# Session state
# =========================================================
defaults = {
    "scan_rows": [],
    "barcode_master": None,
    "barcode_lookup": {},
    "master_name": "",
    "message": "",
    "message_type": "success",
    "barcode_input": "",
    "qty_input": 1.0,
    "remarks_input": "",
    "expiry_input": date.today(),
    "fixed_user": "",
    "fixed_store": "",
    "near_expiry_days": 30,
    "auto_submit_on_scan": False,
    "last_lookup_item": "",
    "last_lookup_desc": "",
    "focus_barcode": True,
}

for key, value in defaults.items():
    if key not in st.session_state:
        st.session_state[key] = value


# =========================================================
# Sidebar
# =========================================================
with st.sidebar:
    st.header("Setup")

    st.text_input("PD/User Name", key="fixed_user", placeholder="Enter user name")
    st.text_input("Store / Location", key="fixed_store", placeholder="Enter store/location")
    st.number_input("Near Expiry Days", min_value=1, max_value=365, key="near_expiry_days")

    st.markdown("---")
    st.subheader("Barcode Master")
    master_file = st.file_uploader("Upload Barcode Master", type=["xlsx", "xls", "csv"])

    if master_file is not None:
        file_bytes = master_file.getvalue()
        file_name = master_file.name

        if st.session_state.master_name != file_name:
            try:
                master_df = load_master_file(file_bytes, file_name)
                st.session_state.barcode_master = master_df
                st.session_state.barcode_lookup = build_lookup(master_df)
                st.session_state.master_name = file_name
                st.session_state.message = f"Barcode master loaded: {len(master_df)} items"
                st.session_state.message_type = "success"
            except Exception as e:
                st.session_state.message = f"Failed to load barcode master: {e}"
                st.session_state.message_type = "error"

    if st.session_state.master_name:
        st.success(f"Loaded: {st.session_state.master_name}")

        if st.button("Clear Saved Barcode Master", use_container_width=True):
            st.session_state.barcode_master = None
            st.session_state.barcode_lookup = {}
            st.session_state.master_name = ""
            st.session_state.message = "Saved barcode master cleared."
            st.session_state.message_type = "success"

    st.markdown("---")
    if st.button("Clear Saved Lines", use_container_width=True):
        st.session_state.scan_rows = []
        st.session_state.message = "Saved lines cleared."
        st.session_state.message_type = "success"


# =========================================================
# Main UI
# =========================================================
st.title("Expiry Scan App")
show_message()

col_a, col_b, col_c = st.columns([1.4, 1, 1])

with col_a:
    st.text_input(
        "Product Barcode",
        key="barcode_input",
        placeholder="Scan barcode here",
        on_change=barcode_changed,
    )

with col_b:
    st.number_input(
        "Quantity",
        min_value=0.0,
        step=1.0,
        key="qty_input",
    )

with col_c:
    st.date_input(
        "Expiry Date",
        key="expiry_input",
        value=st.session_state.expiry_input,
    )

st.text_input("Remarks", key="remarks_input", placeholder="Optional remarks")

lookup_barcode = clean_barcode(st.session_state.get("barcode_input", ""))
if lookup_barcode:
    lookup_current_barcode()

info1, info2, info3, info4 = st.columns(4)
info1.metric("User", st.session_state.fixed_user or "-")
info2.metric("Store", st.session_state.fixed_store or "-")
info3.metric("Saved Lines", len(st.session_state.scan_rows))
info4.metric("Master Items", len(st.session_state.barcode_lookup))

if st.session_state.last_lookup_item or st.session_state.last_lookup_desc:
    st.markdown("### Item Lookup")
    c1, c2 = st.columns(2)
    with c1:
        st.info(f"**Item Number:** {st.session_state.last_lookup_item or '-'}")
    with c2:
        st.info(f"**Description:** {st.session_state.last_lookup_desc or '-'}")

if st.button("Save Scan", use_container_width=True):
    add_scan_row()

if st.session_state.focus_barcode:
    focus_barcode_input()
    st.session_state.focus_barcode = False


# =========================================================
# Data + Export
# =========================================================
raw_df = pd.DataFrame(st.session_state.scan_rows)

if not raw_df.empty:
    st.markdown("### Saved Lines")
    st.dataframe(raw_df.tail(25), use_container_width=True, hide_index=True)

    summary_df = make_summary(raw_df)

    export_col1, export_col2 = st.columns([1, 1])
    with export_col1:
        st.download_button(
            label="Export Excel Report",
            data=to_excel(raw_df, summary_df),
            file_name=f"expiry_report_{date.today().strftime('%Y%m%d')}.xlsx",
            mime="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            use_container_width=True,
        )

    with export_col2:
        csv_data = raw_df.to_csv(index=False).encode("utf-8")
        st.download_button(
            label="Export CSV",
            data=csv_data,
            file_name=f"expiry_report_{date.today().strftime('%Y%m%d')}.csv",
            mime="text/csv",
            use_container_width=True,
        )

    with st.expander("Summary"):
        st.dataframe(summary_df, use_container_width=True, hide_index=True)
else:
    st.button("Export Excel Report", use_container_width=True, disabled=True)