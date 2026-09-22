const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const resultDiv = document.getElementById('result');
const partsListDiv = document.getElementById('parts-list');

const materialSelect = document.getElementById('material');
const layerHeightSelect = document.getElementById('layer-height');
const printersCountInput = document.getElementById('printers-count');

const DENSITY_MULTIPLIER = 1.0;
const WALL_THICKNESS_MM = 1.2;

const SMALL_PART_THRESHOLD_CM3 = 10;
const SMALL_PART_MULTIPLIER = 2.5;

const MATERIAL_DENSITY = { STANDARD: 1.3, TPU: 1.21 };
const MATERIAL_NAMES = { STANDARD: 'PLA/PETG/ABS', TPU: 'TPU' };

// Коэффициенты: полнотелые / пустотелые
const COEFFICIENTS = {
    standard: { solid: 0.58, hollow: 6 },
    high: { solid: 1.05, hollow: 8.5 },
    'very-high': { solid: 1.18, hollow: 10 }
};

// Дебаг режим (добавь ?debug=true в URL)
const DEBUG_MODE = new URLSearchParams(window.location.search).get('debug') === 'true';

// Дисклеймер
const disclaimerModal = document.getElementById('disclaimer-modal');
const closeDisclaimerBtn = document.getElementById('close-disclaimer');

disclaimerModal.classList.add('show');

closeDisclaimerBtn.onclick = () => {
    disclaimerModal.classList.remove('show');
};

let partsList = [];
let nextId = 1;

dropZone.onclick = () => fileInput.click();
dropZone.ondragover = (e) => { e.preventDefault(); dropZone.classList.add('dragover'); };
dropZone.ondragleave = () => dropZone.classList.remove('dragover');
dropZone.ondrop = (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
};
fileInput.onchange = (e) => handleFiles(e.target.files);

materialSelect.onchange = calculateAndDisplay;
layerHeightSelect.onchange = calculateAndDisplay;
printersCountInput.onchange = (e) => {
    let val = parseInt(e.target.value) || 1;
    if (val > 10) val = 10;
    if (val < 1) val = 1;
    e.target.value = val;
    calculateAndDisplay();
};

async function handleFiles(files) {
    for (const file of files) {
        const id = nextId++;
        const part = { id, name: file.name, volumeMm3: 0, areaMm2: 0, bbVolumeMm3: 0, count: 1 };
        partsList.push(part);
        renderPartsList();
        
        try {
            const arrayBuffer = await file.arrayBuffer();
            const uint8Array = new Uint8Array(arrayBuffer);
            const metrics = await parseStepAndCalcMetrics(uint8Array);
            part.volumeMm3 = metrics.volumeMm3;
            part.areaMm2 = metrics.areaMm2;
            part.bbVolumeMm3 = metrics.bbVolumeMm3;
        } catch (err) {
            part.volumeMm3 = -1;
            console.error(`Ошибка в ${file.name}:`, err);
        }
        
        renderPartsList();
        calculateAndDisplay();
    }
}

function renderPartsList() {
    partsListDiv.innerHTML = '';
    for (const part of partsList) {
        const div = document.createElement('div');
        div.className = 'part-item';
        const status = part.volumeMm3 === 0 ? '⏳' : part.volumeMm3 === -1 ? '❌' : '✅';
        
        // В дебаг-режиме показываем объем
        const metricsText = DEBUG_MODE && part.volumeMm3 > 0 
            ? `(${(part.volumeMm3 / 1000).toFixed(1)} см³)` 
            : '';
        
        div.innerHTML = `
            <span>${status}</span>
            <span class="name">${part.name} ${metricsText}</span>
            <input type="number" min="1" value="${part.count}" data-id="${part.id}" class="count-input">
            <button data-id="${part.id}" class="remove-btn">×</button>
        `;
        partsListDiv.appendChild(div);
    }
    
    document.querySelectorAll('.count-input').forEach(input => {
        input.oninput = (e) => {
            const part = partsList.find(p => p.id === parseInt(e.target.dataset.id));
            if (part) { part.count = parseInt(e.target.value) || 1; calculateAndDisplay(); }
        };
    });
    
    document.querySelectorAll('.remove-btn').forEach(btn => {
        btn.onclick = (e) => {
            partsList = partsList.filter(p => p.id !== parseInt(e.target.dataset.id));
            renderPartsList();
            calculateAndDisplay();
        };
    });
}

function calculateAndDisplay() {
    const validParts = partsList.filter(p => p.volumeMm3 > 0);
    if (validParts.length === 0) {
        resultDiv.innerText = partsList.length === 0 ? 'Загрузите .stp файлы' : 'Нет валидных деталей';
        return;
    }
    
    const material = materialSelect.value;
    const printersCount = parseInt(printersCountInput.value) || 1;
    const density = MATERIAL_DENSITY[material];
    
    const layerHeight = layerHeightSelect.value;
    const coeffs = COEFFICIENTS[layerHeight];
    
    let totalVolumeCm3 = 0;
    let totalWeightG = 0;
    let totalTimeMin = 0;
    let totalPartsCount = 0;
    let maxSinglePartTime = 0;
    
    let hasHollowParts = false;
    let hasSmallParts = false;

    for (const part of validParts) {
        const volumeCm3 = part.volumeMm3 / 1000;
        const bbVolumeCm3 = part.bbVolumeMm3 / 1000;
        const areaMm2 = part.areaMm2;
        
        const solidity = volumeCm3 / bbVolumeCm3;
        const isHollow = solidity < 0.35;
        if (isHollow) hasHollowParts = true;
        
        let effectiveVolumeCm3 = volumeCm3;
        if (isHollow) {
            const shellVolumeMm3 = (areaMm2 / 2) * WALL_THICKNESS_MM;
            const shellVolumeCm3 = shellVolumeMm3 / 1000;
            effectiveVolumeCm3 = Math.min(volumeCm3, shellVolumeCm3);
        }
        
        let minutesPerCm3 = isHollow ? coeffs.hollow : coeffs.solid;
        
        if (effectiveVolumeCm3 < SMALL_PART_THRESHOLD_CM3) {
            minutesPerCm3 *= SMALL_PART_MULTIPLIER;
            hasSmallParts = true;
        }
        
        const timePerPart = effectiveVolumeCm3 * minutesPerCm3;
        const weightPerPart = effectiveVolumeCm3 * density * DENSITY_MULTIPLIER;
        
        totalVolumeCm3 += effectiveVolumeCm3 * part.count;
        totalWeightG += weightPerPart * part.count;
        totalTimeMin += timePerPart * part.count;
        totalPartsCount += part.count;
        
        if (timePerPart > maxSinglePartTime) {
            maxSinglePartTime = timePerPart;
        }
    }
    
    const theoreticalTime = Math.ceil(totalTimeMin / printersCount);
    const finalTimeMin = Math.max(maxSinglePartTime, theoreticalTime);
    
    totalWeightG = Math.round(totalWeightG);
    
    // Основной результат (без объема и веса)
    const machineHours = Math.ceil(totalTimeMin);
    const machineHoursFormatted = `${Math.floor(machineHours/60)} ч ${Math.round(machineHours%60)} мин`;

    let resultHTML = `
        <p>🧵 Материал: <b>${MATERIAL_NAMES[material]}</b></p>
        <hr>
        <p>🔢 Всего деталей: <b>${totalPartsCount} шт</b></p>
        <p>🖨️ Принтеров: <b>${printersCount} шт</b></p>
        <hr>
        <p>⏱️ Общее время: <b>~${Math.floor(finalTimeMin/60)} ч ${Math.round(finalTimeMin%60)} мин</b></p>
        <p>⚙️ Машиночасы: <b>~${machineHoursFormatted}</b></p>
    `;
    
    // Дебаг-информация
    if (DEBUG_MODE) {
        let notes = '';
        if (hasHollowParts) {
            notes += '<br><small style="color:#666">* Обнаружены пустотелые модели — расчет по площади стенок.</small>';
        }
        if (hasSmallParts) {
            notes += '<br><small style="color:#666">* Для малых деталей (&lt; ' + SMALL_PART_THRESHOLD_CM3 + ' см³) коэффициент повышен ×' + SMALL_PART_MULTIPLIER + '.</small>';
        }
        
        resultHTML += `
            <hr>
            <p>📦 Эффективный объем: <b>${totalVolumeCm3.toFixed(2)} см³</b></p>
            <p>⚖️ Общий вес: <b>~${totalWeightG} г</b></p>
            ${notes}
        `;
    }
    
    resultDiv.innerHTML = resultHTML;
}

async function parseStepAndCalcMetrics(uint8Array) {
    const occt = await occtimportjs({
        locateFile: (file) => `./${file}`
    });

    const result = occt.ReadStepFile(uint8Array);
    if (!result.success) throw new Error(result.error || "Ошибка парсинга STEP");
    if (!result.meshes || result.meshes.length === 0) throw new Error("Нет 3D-геометрии");

    let totalVolume = 0;
    let totalArea = 0;
    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;
    let minZ = Infinity, maxZ = -Infinity;
    
    for (const mesh of result.meshes) {
        const vertices = mesh.attributes.position.array;
        const indices = mesh.index.array;
        
        for (let i = 0; i < indices.length; i += 3) {
            const i1 = indices[i] * 3;
            const i2 = indices[i+1] * 3;
            const i3 = indices[i+2] * 3;
            
            const p1 = [vertices[i1], vertices[i1+1], vertices[i1+2]];
            const p2 = [vertices[i2], vertices[i2+1], vertices[i2+2]];
            const p3 = [vertices[i3], vertices[i3+1], vertices[i3+2]];
            
            minX = Math.min(minX, p1[0], p2[0], p3[0]);
            maxX = Math.max(maxX, p1[0], p2[0], p3[0]);
            minY = Math.min(minY, p1[1], p2[1], p3[1]);
            maxY = Math.max(maxY, p1[1], p2[1], p3[1]);
            minZ = Math.min(minZ, p1[2], p2[2], p3[2]);
            maxZ = Math.max(maxZ, p1[2], p2[2], p3[2]);
            
            totalVolume += (
                p1[0] * (p2[1]*p3[2] - p2[2]*p3[1]) +
                p1[1] * (p2[2]*p3[0] - p2[0]*p3[2]) +
                p1[2] * (p2[0]*p3[1] - p2[1]*p3[0])
            ) / 6.0;
            
            const v1 = [p2[0]-p1[0], p2[1]-p1[1], p2[2]-p1[2]];
            const v2 = [p3[0]-p1[0], p3[1]-p1[1], p3[2]-p1[2]];
            const cross = [v1[1]*v2[2] - v1[2]*v2[1], v1[2]*v2[0] - v1[0]*v2[2], v1[0]*v2[1] - v1[1]*v2[0]];
            totalArea += Math.sqrt(cross[0]*cross[0] + cross[1]*cross[1] + cross[2]*cross[2]) / 2.0;
        }
    }
    
    
    const bbVolume = (maxX - minX) * (maxY - minY) * (maxZ - minZ);
    
    return {
        volumeMm3: Math.abs(totalVolume),
        areaMm2: totalArea,
        bbVolumeMm3: bbVolume > 0 ? bbVolume : Math.abs(totalVolume)
    };
}
