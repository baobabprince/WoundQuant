import re
import cv2
import numpy as np
import pandas as pd
import plotly.express as px
import streamlit as st
from skimage.filters.rank import entropy
from skimage.morphology import disk, remove_small_holes, remove_small_objects, convex_hull_image
from skimage.measure import label, regionprops

# הגדרת דף Streamlit
st.set_page_config(page_title="WoundQuant", page_icon="🔬", layout="wide")

st.title("🔬 WoundQuant — Batch Burn Recovery & Velocity Analyzer")
st.markdown("ניתוח אצוות דינמי של סדרות עיתיות, אחוזי סגירה וקצב שינוי ($dArea/dt$) לכל הבארות במקביל")

# --- RegEx & Parsing ---
FILENAME_PATTERN = re.compile(
    r"_(?P<well>[A-H]\d{1,2})_(?P<site>\d+)_(?P<days>\d{2})d(?P<hours>\d{2})h(?P<mins>\d{2})m"
)

def parse_uploaded_files(uploaded_files):
    records = []
    for file in uploaded_files:
        match = FILENAME_PATTERN.search(file.name)
        if match:
            d = match.groupdict()
            total_hours = int(d["days"]) * 24 + int(d["hours"]) + int(d["mins"]) / 60
            records.append({
                "filename": file.name,
                "file_obj": file,
                "well": d["well"],
                "site": int(d["site"]),
                "hours": total_hours,
                "series_id": f"{d['well']}_Site{d['site']}"
            })
    df = pd.DataFrame(records)
    if not df.empty:
        df = df.sort_values(by=["well", "site", "hours"])
    return df

# --- Step 1: Detect Well Border / Mask ---
def get_well_mask(img, crop_margin=15):
    h, w = img.shape
    blurred = cv2.GaussianBlur(img, (11, 11), 0)
    _, thresh_well = cv2.threshold(blurred, 15, 255, cv2.THRESH_BINARY)
    contours, _ = cv2.findContours(thresh_well, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    
    well_mask = np.zeros_like(img, dtype=np.uint8)
    
    if contours:
        c = max(contours, key=cv2.contourArea)
        cv2.drawContours(well_mask, [c], -1, 255, thickness=cv2.FILLED)
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (crop_margin, crop_margin))
        well_mask = cv2.erode(well_mask, kernel, iterations=2)
    else:
        center = (w // 2, h // 2)
        radius = min(w, h) // 2 - crop_margin
        cv2.circle(well_mask, center, radius, 255, thickness=-1)
        
    return well_mask

# --- Step 2: Main Image Processing Pipeline ---
def process_single_frame(img, entropy_radius, manual_thresh, invert_thresh, min_hole_size, use_hull, crop_margin):
    if img is None:
        return None, None, None, 0

    well_roi = get_well_mask(img, crop_margin=crop_margin)

    ent_map = entropy(img, disk(entropy_radius))
    ent_norm = cv2.normalize(ent_map, None, 0, 255, cv2.NORM_MINMAX).astype(np.uint8)
    ent_roi = cv2.bitwise_and(ent_norm, ent_norm, mask=well_roi)

    if manual_thresh == 0:
        roi_pixels = ent_roi[well_roi > 0]
        if len(roi_pixels) > 0:
            otsu_val, _ = cv2.threshold(roi_pixels, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
        else:
            otsu_val = 128
        thresh_val = otsu_val
    else:
        thresh_val = manual_thresh

    if invert_thresh:
        binary = (ent_roi < thresh_val) & (well_roi > 0)
    else:
        binary = (ent_roi >= thresh_val) & (well_roi > 0)

    cleaned = remove_small_objects(binary, min_size=500)
    filled = remove_small_holes(cleaned, area_threshold=min_hole_size)

    labeled = label(filled)
    regions = regionprops(labeled)

    if not regions:
        return ent_roi, (binary.astype(np.uint8)*255), np.zeros_like(img), 0

    largest_region = max(regions, key=lambda r: r.area)
    continuous_mask = (labeled == largest_region.label)

    if use_hull and np.any(continuous_mask):
        continuous_mask = convex_hull_image(continuous_mask)

    final_mask = continuous_mask.astype(np.uint8) * 255
    area_pixels = int(np.sum(continuous_mask))

    return ent_roi, (binary.astype(np.uint8)*255), final_mask, area_pixels

# --- Sidebar Controls ---
st.sidebar.header("📁 העלאת קבצים וכיול")

uploaded_files = st.sidebar.file_uploader(
    "גרור לכאן את תמונות הניסוי:",
    type=["tif", "tiff", "png", "jpg", "jpeg"],
    accept_multiple_files=True
)

st.sidebar.subheader("⚙️ כיול סגמנטציה")
entropy_rad = st.sidebar.slider("רדיוס אנטרופיה (Entropy Radius):", 1, 20, 7)
crop_margin = st.sidebar.slider("שולי הפרדה מגבול הבארית (Crop Margin):", 1, 30, 15)
invert_thresh = st.sidebar.checkbox("הפוך סף סגמנטציה (Invert Threshold)", value=True)
manual_thresh = st.sidebar.slider("סף אנטרופיה ידני (0 = Otsu אוטומטי):", 0, 255, 0)
min_hole = st.sidebar.slider("גודל חור מינימלי למילוי:", 500, 50000, 10000)
use_hull = st.sidebar.checkbox("כפה מעטפת קמורה (Convex Hull)", value=True)

# --- Main Logic ---
if uploaded_files:
    df_files = parse_uploaded_files(uploaded_files)

    if df_files.empty:
        st.warning("לא נמצאו קבצים המתאימים לפורמט השמות.")
    else:
        st.sidebar.success(f"הועלו {len(df_files)} תמונות מתוך {df_files['series_id'].nunique()} סדרות (Well/Site)!")

        tab_preview, tab_batch = st.tabs(["🔍 כיול פריים בודד (Preview & Tune)", "🚀 הרצת אצווה מלאה וניתוח שינוי"])

        # --- Tab 1: Single Frame Preview ---
        with tab_preview:
            st.markdown("### בדיקה וכיול פרמטרים על סדרה וזמן ספציפיים")
            
            p_series = st.selectbox("בחר סדרה לכיול (Well_Site):", sorted(df_files["series_id"].unique()))
            sub_df_prev = df_files[df_files["series_id"] == p_series]
            
            preview_time = st.select_slider(
                "בחר נקודת זמן לבדיקה:",
                options=sorted(sub_df_prev["hours"].unique())
            )

            selected_row = sub_df_prev[sub_df_prev["hours"] == preview_time].iloc[0]
            file_bytes = np.frombuffer(selected_row["file_obj"].read(), np.uint8)
            img = cv2.imdecode(file_bytes, cv2.IMREAD_GRAYSCALE)
            selected_row["file_obj"].seek(0)

            ent_map, binary_img, mask, area = process_single_frame(
                img, entropy_rad, manual_thresh, invert_thresh, min_hole, use_hull, crop_margin
            )

            col1, col2, col3 = st.columns(3)
            with col1:
                st.image(img, caption="תמונת מקור (Phase Contrast)", use_container_width=True)
            with col2:
                st.image(ent_map, caption="אנטרופיה בתוך תחום הבארית בלבד", use_container_width=True)
            with col3:
                overlay = cv2.cvtColor(img, cv2.COLOR_GRAY2RGB)
                overlay[mask > 0] = [255, 0, 0]
                blended = cv2.addWeighted(cv2.cvtColor(img, cv2.COLOR_GRAY2RGB), 0.7, overlay, 0.3, 0)
                st.image(blended, caption=f"סימון כוויה (שטח: {area} px)", use_container_width=True)

        # --- Tab 2: Full Batch Analysis & Rate of Change ---
        with tab_batch:
            st.markdown("### ניתוח אצווה של כל הסדרות העיתיות")
            
            if st.button("🚀 הרץ ניתוח אצווה לכל הבארות במקביל", type="primary"):
                all_results = []
                masks_cache = {}
                imgs_cache = {}

                progress_bar = st.progress(0)
                status_text = st.empty()
                total_files = len(df_files)

                for idx, row in df_files.iterrows():
                    status_text.text(f"מעבד {idx+1}/{total_files}: {row['filename']}...")
                    
                    f_bytes = np.frombuffer(row["file_obj"].read(), np.uint8)
                    frame_img = cv2.imdecode(f_bytes, cv2.IMREAD_GRAYSCALE)
                    row["file_obj"].seek(0)

                    _, _, f_mask, f_area = process_single_frame(
                        frame_img, entropy_rad, manual_thresh, invert_thresh, min_hole, use_hull, crop_margin
                    )

                    all_results.append({
                        "Series": row["series_id"],
                        "Well": row["well"],
                        "Site": row["site"],
                        "Time (Hours)": row["hours"],
                        "Burn Area (px)": f_area
                    })

                    key = (row["series_id"], row["hours"])
                    masks_cache[key] = f_mask
                    imgs_cache[key] = frame_img

                    progress_bar.progress((idx + 1) / total_files)

                status_text.success("העיבוד הושלם בהצלחה עבור כל הסדרות!")

                batch_df = pd.DataFrame(all_results)

                # --- חישוב אחוז סגירה וקצב שינוי (Rate of Closure / Velocity) ---
                calculated_dfs = []
                for s_id, group in batch_df.groupby("Series"):
                    group = group.sort_values(by="Time (Hours)")
                    init_area = group["Burn Area (px)"].iloc[0] if not group.empty else 0
                    
                    if init_area > 0:
                        group["Wound Closure (%)"] = ((1 - (group["Burn Area (px)"] / init_area)) * 100).clip(lower=0)
                    else:
                        group["Wound Closure (%)"] = 0.0

                    # קצב שינוי אחוזים לשעה: d(%)/dt
                    group["Time_Diff"] = group["Time (Hours)"].diff()
                    group["Closure_Diff"] = group["Wound Closure (%)"].diff()
                    
                    # חישוב מהירות סגירה (אחוז לשעה)
                    group["Closure Rate (%/h)"] = (group["Closure_Diff"] / group["Time_Diff"]).fillna(0)
                    
                    # חישוב מהירות שינוי שטח פיקסלים לשעה: -d(Area)/dt
                    group["Area_Diff"] = -group["Burn Area (px)"].diff()
                    group["Area Rate (px/h)"] = (group["Area_Diff"] / group["Time_Diff"]).fillna(0)

                    calculated_dfs.append(group)

                final_batch_df = pd.concat(calculated_dfs, ignore_index=True)

                st.session_state["batch_data"] = {
                    "df": final_batch_df,
                    "masks": masks_cache,
                    "imgs": imgs_cache
                }

            if "batch_data" in st.session_state:
                b_cache = st.session_state["batch_data"]
                res_df = b_cache["df"]
                masks_dict = b_cache["masks"]
                imgs_dict = b_cache["imgs"]

                st.subheader("📊 תוצאות והשוואת סדרות")

                series_list = sorted(res_df["Series"].unique())
                selected_series = st.multiselect("סינון סדרות להצגה בגרפים:", series_list, default=series_list)

                filtered_df = res_df[res_df["Series"].isin(selected_series)]

                col_g1, col_g2 = st.columns(2)

                with col_g1:
                    fig_closure = px.line(
                        filtered_df,
                        x="Time (Hours)",
                        y="Wound Closure (%)",
                        color="Series",
                        markers=True,
                        title="אחוז סגירת הכוויה מצטבר (Wound Closure %)"
                    )
                    fig_closure.update_layout(yaxis_range=[0, 105])
                    st.plotly_chart(fig_closure, use_container_width=True)

                with col_g2:
                    fig_rate = px.line(
                        filtered_df,
                        x="Time (Hours)",
                        y="Closure Rate (%/h)",
                        color="Series",
                        markers=True,
                        title="קצב סגירה רגעי (%/h - Rate of Closure / Velocity)"
                    )
                    st.plotly_chart(fig_rate, use_container_width=True)

                st.markdown("---")
                st.subheader("🖼️ סקירה ויזואלית אינטראקטיבית לסדרה נבחרת")

                col_sel1, col_sel2 = st.columns(2)
                with col_sel1:
                    inspect_series = st.selectbox("בחר סדרה לתצוגה:", series_list)
                
                sub_inspect = res_df[res_df["Series"] == inspect_series]
                
                with col_sel2:
                    inspect_time = st.select_slider(
                        "בחר זמן בסדרה:",
                        options=sorted(sub_inspect["Time (Hours)"].unique())
                    )

                key = (inspect_series, inspect_time)
                if key in masks_dict and key in imgs_dict:
                    img_curr = imgs_dict[key]
                    mask_curr = masks_dict[key]

                    overlay = cv2.cvtColor(img_curr, cv2.COLOR_GRAY2RGB)
                    overlay[mask_curr > 0] = [255, 0, 0]
                    blended = cv2.addWeighted(cv2.cvtColor(img_curr, cv2.COLOR_GRAY2RGB), 0.7, overlay, 0.3, 0)

                    c_row = sub_inspect[sub_inspect["Time (Hours)"] == inspect_time].iloc[0]
                    
                    col_i1, col_i2 = st.columns([1, 1])
                    with col_i1:
                        st.image(
                            blended,
                            caption=f"{inspect_series} | {inspect_time}h | שטח: {c_row['Burn Area (px)']} px | סגירה: {c_row['Wound Closure (%)']:.1f}%",
                            use_container_width=True
                        )
                    with col_i2:
                        st.metric("שטח כוויה (px)", f"{c_row['Burn Area (px)']:,}")
                        st.metric("סגירה מצטברת (%)", f"{c_row['Wound Closure (%)']:.1f}%")
                        st.metric("קצב סגירה רגעי (%/שעה)", f"{c_row['Closure Rate (%/h)']:.2f} %/h")

                st.markdown("---")
                st.subheader("📥 הורדת טבלת הנתונים המלאה")
                st.dataframe(filtered_df, hide_index=True)
                
                csv_data = filtered_df.to_csv(index=False).encode('utf-8')
                st.download_button(
                    label="📥 הורד קובץ CSV של תוצאות האצווה",
                    data=csv_data,
                    file_name="woundquant_batch_results.csv",
                    mime="text/csv"
                )

else:
    st.info("אנא גרור קובצי תמונות בסרגל הצד (Sidebar) כדי להתחיל בניתוח.")