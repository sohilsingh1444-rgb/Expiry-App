import os
import uuid
from datetime import date

import pandas as pd
import streamlit as st
from supabase import create_client


st.set_page_config(page_title="Expiry Scan App", layout="wide")

LOCAL_BARCODE_MASTER_FILE = "saved_barcode_master.xlsx"


@st.cache_resource
def get_supabase():
    return create_client(
        st.secrets["SUPABASE_URL"],
        st.secrets["SUPABASE_KEY"],
    )


supabase = get_supabase()


def normalize_barcode(value) -> str:
    if value is None:
        return ""
    text = str(value).strip()
    if text.endswith(".0"):
        text = text[:-2]
    return text


def calculate_status(expiry_date: date, today_date: date):
    days_left = (expiry_date - today_date).days

    if days_left < 0:
        return days_left, "Expired", "Remove from shelf"
    elif days_left <= 2:
        return days_left, "Urgent", "Immediate review / markdown"
    elif days_left <= 7:
        return days_left, "Near Expiry", "Monitor / markdown"
    else:
        return days_left, "OK", ""


def standardize_barcode_master(df: pd.DataFrame) -> pd.DataFrame:
    if df.empty:
        return pd.DataFrame(columns=["barcode", "item_number", "description"])

    df = df.copy()
    df.columns = [str(c).strip() for c in df.columns]
    lower_map = {c.lower(): c for c in df.columns}

    barcode_col = None
    item_col = None
    desc_col = None

    barcode_candidates = ["barcode", "ean", "upc", "item barcode"]
    item_candidates = ["item number", "item no", "item_no", "item", "no."]
    desc_candidates = ["description", "item description", "desc"]

    for c in barcode_candidates:
        if c in lower_map:
            barcode_col = lower_map[c]
            break

    for c in item_candidates:
        if c in lower_map:
            item_col = lower_map[c]
            break

    for c in desc_candidates:
        if c in lower_map:
            desc_col = lower_map[c]
            break

    if not barcode_col:
        return pd.DataFrame(columns=["barcode", "item_number", "description"])

    if not item_col:
        df["__item_number__"] = ""
        item_col = "__item_number__"

    if not desc_col:
        df["__description__"] = ""
        desc_col = "__description__"

    out = df[[barcode_col, item_col, desc_col]].copy()
    out.columns = ["barcode", "item_number", "description"]
    out["barcode"] = out["barcode"].apply(normalize_barcode)
    out["item_number"] = out["item_number"].fillna("").astype(str).str.strip()
    out["description"] = out["description"].fillna("").astype(str).str.strip()
    out = out[out["barcode"] != ""].drop_duplicates(subset=["barcode"], keep="first")

    return out


def load_barcode_master_file(uploaded_file) -> pd.DataFrame:
    df = pd.read_excel(uploaded_file)
    return standardize_barcode_master(df)


def save_barcode_master_local(df: pd.DataFrame):
    df.to_excel(LOCAL_BARCODE_MASTER_FILE, index=False)


def load_barcode_master_local() -> pd.DataFrame:
    if not os.path.exists(LOCAL_BARCODE_MASTER_FILE):
        return pd.DataFrame(columns=["barcode", "item_number", "description"])

    try:
        df = pd.read_excel(LOCAL_BARCODE_MASTER_FILE)
        return standardize_barcode_master(df)
    except Exception:
        return pd.DataFrame(columns=["barcode", "item_number", "description"])


def get_barcode_lookup(df: pd.DataFrame):
    if df.empty:
        return {}
    return {
        row["barcode"]: {
            "item_number": row["item_number"],
            "description": row["description"],
        }
        for _, row in df.iterrows()
    }


def get_latest_session_id(pd_user_name: str, store_location: str, scan_date_value: date):
    try:
        res = (
            supabase.table("expiry_scans")
            .select("session_id, created_at")
            .eq("pd_user_name", pd_user_name)
            .eq("store_location", store_location)
            .eq("scan_date", scan_date_value.isoformat())
            .order("created_at", desc=True)
            .limit(1)
            .execute()
        )
        if res.data:
            return res.data[0]["session_id"]
    except Exception:
        pass
    return None


def create_new_session_id(pd_user_name: str, store_location: str, scan_date_value: date):
    return f"{store_location}_{pd_user_name}_{scan_date_value.isoformat()}_{uuid.uuid4().hex[:8]}"


def fetch_session_rows(session_id: str) -> pd.DataFrame:
    res = (
        supabase.table("expiry_scans")
        .select("*")
        .eq("session_id", session_id)
        .order("created_at", desc=False)
        .execute()
    )

    rows = res.data if res.data else []
    if not rows:
        return pd.DataFrame()

    df = pd.DataFrame(rows)

    if "expiry_date" in df.columns:
        df["expiry_date"] = pd.to_datetime(df["expiry_date"]).dt.date
    if "scan_date" in df.columns:
        df["scan_date"] = pd.to_datetime(df["scan_date"]).dt.date
    if "created_at" in df.columns:
        df["created_at"] = pd.to_datetime(df["created_at"], errors="coerce")

    return df


def insert_scan(
    session_id: str,
    pd_user_name: str,
    store_location: str,
    barcode: str,
    item_number: str,
    description: str,
    qty: float,
    expiry_date: date,
    status: str,
    days_left: int,
    scan_date_value: date,
    action_required: str,
    remarks: str,
):
    payload = {
        "session_id": session_id,
        "pd_user_name": pd_user_name,
        "store_location": store_location,
        "barcode": barcode,
        "item_number": item_number if item_number else None,
        "description": description if description else None,
        "qty": qty,
        "expiry_date": expiry_date.isoformat(),
        "status": status,
        "days_left": days_left,
        "scan_date": scan_date_value.isoformat(),
        "action_required": action_required if action_required else None,
        "remarks": remarks if remarks else None,
    }

    return supabase.table("expiry_scans").insert(payload).execute()


def delete_scan(row_id: int):
    return supabase.table("expiry_scans").delete().eq("id", row_id).execute()


def build_excel(df: pd.DataFrame) -> bytes:
    export_df = df.copy()

    preferred_cols = [
        "id",
        "session_id",
        "pd_user_name",
        "store_location",
        "barcode",
        "item_number",
        "description",
        "qty",
        "expiry_date",
        "status",
        "days_left",
        "scan_date",
        "action_required",
        "remarks",
        "created_at",
    ]
    export_df = export_df[[c for c in preferred_cols if c in export_df.columns]]

    file_name = "expiry_export.xlsx"

    with pd.ExcelWriter(
        file_name,
        engine="xlsxwriter",
        date_format="dd/mm/yyyy",
        datetime_format="dd/mm/yyyy hh:mm:ss",
    ) as writer:
        export_df.to_excel(writer, sheet_name="Expiry Scans", index=False)
        workbook = writer.book
        worksheet = writer.sheets["Expiry Scans"]

        header_fmt = workbook.add_format({"bold": True})
        for col_num, col_name in enumerate(export_df.columns):
            worksheet.write(0, col_num, col_name, header_fmt)
            max_len = max(
                len(str(col_name)),
                export_df.iloc[:, col_num].astype(str).map(len).max() if not export_df.empty else 10,
            )
            worksheet.set_column(col_num, col_num, min(max(max_len + 2, 12), 35))

        worksheet.freeze_panes(1, 0)

    with open(file_name, "rb") as f:
        return f.read()


if "barcode_master_df" not in st.session_state:
    st.session_state["barcode_master_df"] = load_barcode_master_local()

if "active_session_id" not in st.session_state:
    st.session_state["active_session_id"] = None

if "last_context_key" not in st.session_state:
    st.session_state["last_context_key"] = None


st.title("Expiry Scan App")

today = date.today()

with st.sidebar:
    st.header("Setup")

    pd_user_name = st.text_input("PD User Name")
    store_location = st.text_input("Store Location")
    scan_date_value = st.date_input("Scan Date", value=today)

    st.markdown("---")
    st.subheader("Barcode Master")

    uploaded_master = st.file_uploader(
        "Upload Barcode Master",
        type=["xlsx", "xls"],
        help="Upload once. It will be saved locally for next time.",
    )

    if uploaded_master is not None:
        try:
            master_df = load_barcode_master_file(uploaded_master)
            st.session_state["barcode_master_df"] = master_df
            save_barcode_master_local(master_df)
            st.success(f"Barcode master loaded and saved: {len(master_df)} rows")
        except Exception as e:
            st.error(f"Failed to load barcode master: {e}")

    if not st.session_state["barcode_master_df"].empty:
        st.caption(f"Saved barcode master rows: {len(st.session_state['barcode_master_df'])}")

    if st.button("Clear Saved Barcode Master"):
        if os.path.exists(LOCAL_BARCODE_MASTER_FILE):
            os.remove(LOCAL_BARCODE_MASTER_FILE)
        st.session_state["barcode_master_df"] = pd.DataFrame(columns=["barcode", "item_number", "description"])
        st.success("Saved barcode master cleared.")
        st.rerun()

ready = bool(pd_user_name.strip()) and bool(store_location.strip())

if not ready:
    st.info("Enter PD User Name and Store Location to begin.")
    st.stop()

context_key = f"{pd_user_name.strip()}|{store_location.strip()}|{scan_date_value.isoformat()}"

if st.session_state["last_context_key"] != context_key:
    latest_session = get_latest_session_id(pd_user_name.strip(), store_location.strip(), scan_date_value)
    if latest_session:
        st.session_state["active_session_id"] = latest_session
    else:
        st.session_state["active_session_id"] = create_new_session_id(
            pd_user_name.strip(),
            store_location.strip(),
            scan_date_value,
        )
    st.session_state["last_context_key"] = context_key

session_id = st.session_state["active_session_id"]
session_df = fetch_session_rows(session_id)

col1, col2, col3, col4 = st.columns(4)
col1.metric("Scans", len(session_df))
col2.metric("Active Items", len(session_df[session_df["expiry_date"] >= today]) if not session_df.empty else 0)
col3.metric("Expired Items", len(session_df[session_df["expiry_date"] < today]) if not session_df.empty else 0)
col4.metric("Total Qty", f"{session_df['qty'].sum():.2f}" if not session_df.empty else "0.00")

st.caption(f"Session ID: {session_id}")

st.subheader("Add Scan")

barcode_lookup = get_barcode_lookup(st.session_state["barcode_master_df"])

with st.form("scan_form", clear_on_submit=True):
    c1, c2, c3 = st.columns([2, 1, 1])

    with c1:
        barcode = st.text_input("Barcode")
    with c2:
        qty = st.number_input("Qty", min_value=0.01, value=1.00, step=1.00, format="%.2f")
    with c3:
        expiry_date = st.date_input("Expiry Date", value=today)

    remarks = st.text_input("Remarks (optional)")
    submit = st.form_submit_button("Save Scan")

    if submit:
        barcode_clean = normalize_barcode(barcode)

        if not barcode_clean:
            st.error("Please enter barcode.")
        else:
            matched = barcode_lookup.get(barcode_clean, {})
            item_number = matched.get("item_number", "")
            description = matched.get("description", "")

            days_left, status, action_required = calculate_status(expiry_date, today)

            try:
                insert_scan(
                    session_id=session_id,
                    pd_user_name=pd_user_name.strip(),
                    store_location=store_location.strip(),
                    barcode=barcode_clean,
                    item_number=item_number,
                    description=description,
                    qty=float(qty),
                    expiry_date=expiry_date,
                    status=status,
                    days_left=days_left,
                    scan_date_value=scan_date_value,
                    action_required=action_required,
                    remarks=remarks.strip(),
                )
                st.success(f"Saved: {barcode_clean}")
                st.rerun()
            except Exception as e:
                st.error(f"Save failed: {e}")

st.subheader("Session Data")

if session_df.empty:
    st.info("No scans saved yet.")
else:
    show_active_only = st.toggle("Show only non-expired items", value=True)

    view_df = session_df.copy()
    if show_active_only:
        view_df = view_df[view_df["expiry_date"] >= today].copy()

    display_cols = [
        "id",
        "barcode",
        "item_number",
        "description",
        "qty",
        "expiry_date",
        "status",
        "days_left",
        "scan_date",
        "action_required",
        "remarks",
        "created_at",
    ]
    display_cols = [c for c in display_cols if c in view_df.columns]

    st.dataframe(view_df[display_cols], use_container_width=True, hide_index=True)

    st.markdown("### Delete Wrong Scan")

    delete_df = view_df[["id", "barcode", "description", "expiry_date", "status"]].copy()
    delete_df["label"] = delete_df.apply(
        lambda r: f"ID {r['id']} | {r['barcode']} | {r['description']} | {r['expiry_date']} | {r['status']}",
        axis=1,
    )
    delete_map = dict(zip(delete_df["label"], delete_df["id"]))

    selected_delete = st.selectbox("Select row", options=[""] + list(delete_map.keys()))

    if st.button("Delete Selected Scan"):
        if not selected_delete:
            st.warning("Select a row first.")
        else:
            try:
                delete_scan(delete_map[selected_delete])
                st.success("Row deleted.")
                st.rerun()
            except Exception as e:
                st.error(f"Delete failed: {e}")

    st.markdown("### Export")

    excel_bytes = build_excel(view_df)
    export_name = f"expiry_scans_{store_location}_{pd_user_name}_{scan_date_value.isoformat()}.xlsx".replace(" ", "_")

    st.download_button(
        "Download Excel",
        data=excel_bytes,
        file_name=export_name,
        mime="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    )