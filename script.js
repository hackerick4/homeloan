// script.js

document.addEventListener('DOMContentLoaded', () => {
    console.log("App Initializing...");

    // 1. 初始化 DOM 元素
    const dom = {
        navItems: document.querySelectorAll('.nav-item'),
        viewSections: document.querySelectorAll('.view-section'),
        inputs: {
            totalPrice: document.getElementById('input-total-price'),
            loanRatio: document.getElementById('input-loan-ratio')
        },
        display: {
            loanAmount: document.getElementById('display-loan-amount'),
        },
        tableBody: document.querySelector('#comparison-table tbody'),
        vizContainer: document.getElementById('d3-viz-container'),
        pdfList: document.getElementById('pdf-list'),
        pdfIframe: document.getElementById('pdf-iframe'),
        pdfPlaceholder: document.getElementById('pdf-placeholder'),
        tableHeader: document.querySelector('.table-card .card-header h3')
    };

    // 2. 狀態管理
    let state = {
        totalPrice: window.LoanConfig.defaultValues.totalPrice, // 元
        loanRatio: window.LoanConfig.defaultValues.loanRatio * 100, // as percentage 75
        loanAmount: 0, // calculated
        activeBankId: null, // for PDF
        currentResults: [] // Store results for modal access
    };

    // 3. 核心計算邏輯
    function calculateLoan() {
        console.log("Calculating Loan...");
        // 計算貸款總額
        state.loanAmount = Math.floor(state.totalPrice * (state.loanRatio / 100));

        // 更新顯示
        dom.display.loanAmount.textContent = (state.loanAmount / 10000).toLocaleString('zh-TW', { maximumFractionDigits: 1 });

        if (!window.LoanConfig.banks || window.LoanConfig.banks.length === 0) {
            console.error("No banks found in Config!");
            dom.tableHeader.textContent = "銀行方案 (Error: 無資料)";
            return;
        }

        // Debug info
        dom.tableHeader.textContent = `銀行方案詳細數據比較 (共 ${window.LoanConfig.banks.length} 筆)`;


        // 3a. 尋找最佳「補位」銀行 (Uncapped & Lowest Monthly Payment)
        // 用於當某銀行額度不足時，剩下的金額由這家銀行補足
        // 用戶傾向於更長的年限 (e.g. 40年) 以降低月付金，因此這裡選 "最低寬限期後月付" (長期負擔最低)
        const uncappedBanks = window.LoanConfig.banks.filter(b => !b.maxLoanAmount || b.maxLoanAmount >= state.loanAmount);
        let fallbackBank = null;
        if (uncappedBanks.length > 0) {
            let bestScore = Infinity;
            uncappedBanks.forEach(b => {
                const sim = calculateBankDetails(b, state.loanAmount, false); // Simulate full amount
                // Optimize for Lowest Post-Grace Payment (Long-term Affordability)
                if (sim.summary.firstPostGracePayment < bestScore) {
                    bestScore = sim.summary.firstPostGracePayment;
                    fallbackBank = b;
                }
            });
        }


        // 計算每家銀行的數據 (含聯貸/組合邏輯)
        const results = window.LoanConfig.banks.map(bank => {
            // Check if capped
            if (bank.maxLoanAmount && state.loanAmount > bank.maxLoanAmount) {
                // 需要組合貸款
                const primaryAmount = bank.maxLoanAmount;
                const gapAmount = state.loanAmount - primaryAmount;

                // 1. Primary Loan
                const primaryResult = calculateBankDetails(bank, primaryAmount, true); // is primary of combo

                // 2. Secondary Loan (Gap)
                let secondaryResult = null;
                if (fallbackBank) {
                    // Use the fallback bank for the gap
                    secondaryResult = calculateBankDetails(fallbackBank, gapAmount, false);
                } else {
                    secondaryResult = calculateBankDetails(bank, gapAmount, false);
                }

                // 3. Combine Results
                return combineResults(primaryResult, secondaryResult, gapAmount, fallbackBank);

            } else {
                // 足額，直接計算
                return calculateBankDetails(bank, state.loanAmount, false);
            }
        });

        // 4. 更新表格
        state.currentResults = results; // Save for modal
        renderTable(results);

        // 5. 更新視覺化圖表
        renderViz(results, fallbackBank);
    }

    /**
     * 組合兩個貸款計算結果
     */
    function combineResults(primary, secondary, gapAmount, secondaryBank) {
        // Summary Summation
        const totalInterest = primary.summary.totalInterest + secondary.summary.totalInterest;
        const totalPayment = primary.summary.totalPayment + secondary.summary.totalPayment;

        // 寬限期內 (假設兩者寬限期重疊，取最小或各自計算? 簡單起見各自計算首月相加)
        const firstMonthPayment = primary.summary.firstMonthPayment + secondary.summary.firstMonthPayment;

        // 寬限期後 (Post Grace)
        // 這裡比較複雜因為寬限期可能不同。
        // 我們定義 "寬限期後月付" 為：當兩者都進入本息攤還時的加總 (Max of grace periods? or just check a later month?)
        // 簡單做法：取出第 (MaxGrace + 1) 個月的付款金額
        const logicMonth = Math.max(primary.bank.gracePeriod, secondaryBank ? secondaryBank.gracePeriod : 0) * 12 + 2;
        // Find payment at logicMonth for both
        const p1 = getPaymentAtMonth(primary, logicMonth);
        const p2 = getPaymentAtMonth(secondary, logicMonth);
        const firstPostGracePayment = p1 + p2;


        return {
            bank: primary.bank,
            isCombo: true,
            secondaryBank: secondaryBank,
            gapAmount: gapAmount,
            effectivePrincipal: primary.effectivePrincipal + gapAmount, // Should equal total
            summary: {
                firstMonthPayment: firstMonthPayment,
                firstPostGracePayment: firstPostGracePayment,
                totalInterest: totalInterest,
                totalPayment: totalPayment
            }
        };
    }

    function getPaymentAtMonth(res, monthIndex) {
        if (monthIndex < res.monthlyData.length) {
            return res.monthlyData[monthIndex].payment;
        }
        return 0; // Should not happen if within 30/40 years
    }

    /**
     * 計算單一銀行的還款細節
     * @param bank 銀行物件
     * @param principal 本金
     * @param isCappedCalculation 是否為有上限的計算 (影響顯示邏輯，但在這裡純數學計算沒差)
     */
    function calculateBankDetails(bank, principal, isCappedCalculation) {
        // Determine Loan Term: Use Bank Specific if longer than default, otherwise default
        let bankTerm = 0;
        if (bank.rates && bank.rates.length > 0) {
            bankTerm = bank.rates.reduce((acc, r) => acc + r.year, 0); // e.g. 40
        }
        const configTerm = window.LoanConfig.defaultValues.loanTermYears; // 30
        const finalYearTerm = Math.max(bankTerm, configTerm);
        // User requested: Fubon is 40 years.
        // If config rates say 40 years, we should use it.

        const totalMonths = finalYearTerm * 12;

        let monthlyData = [];

        // Add Month 0
        monthlyData.push({
            month: 0,
            payment: 0,
            remaining: principal,
            cumulativePayment: 0
        });

        let remainingPrincipal = principal;
        let totalInterest = 0;
        let totalPayment = 0;
        let gracePeriodMonths = bank.gracePeriod * 12;

        let currentRateIndex = 0;
        let currentRateEndMonth = getMacRateEndMonth(bank.rates, 0);

        for (let month = 1; month <= totalMonths; month++) {
            // 決定當前利率
            if (month > currentRateEndMonth && currentRateIndex < bank.rates.length - 1) {
                currentRateIndex++;
                currentRateEndMonth = getMacRateEndMonth(bank.rates, currentRateIndex);
            }
            const annualRate = bank.rates[currentRateIndex].rate;
            const monthlyRate = annualRate / 100 / 12;

            let interestPayment = Math.round(remainingPrincipal * monthlyRate);
            let principalPayment = 0;
            let monthlyTotal = 0;

            if (month <= gracePeriodMonths) {
                // 寬限期: 只繳息
                monthlyTotal = interestPayment;
            } else {
                // 本息均攤
                const remainingMonths = totalMonths - month + 1;
                const pmt = Math.round((remainingPrincipal * monthlyRate * Math.pow(1 + monthlyRate, remainingMonths)) / (Math.pow(1 + monthlyRate, remainingMonths) - 1));
                monthlyTotal = pmt;
                principalPayment = monthlyTotal - interestPayment;
            }

            remainingPrincipal -= principalPayment;
            let remainingDisplay = remainingPrincipal < 0 ? 0 : remainingPrincipal;

            totalInterest += interestPayment;
            totalPayment += monthlyTotal;

            monthlyData.push({
                month: month,
                interest: interestPayment,
                principal: principalPayment,
                payment: monthlyTotal,
                remaining: remainingDisplay,
                cumulativePayment: totalPayment
            });
        }

        return {
            bank: bank,
            monthlyData: monthlyData,
            effectivePrincipal: principal,
            isCapped: isCappedCalculation, // Just a flag
            summary: {
                firstMonthPayment: monthlyData[1] ? monthlyData[1].payment : 0,
                firstPostGracePayment: monthlyData[gracePeriodMonths + 1] ? monthlyData[gracePeriodMonths + 1].payment : 0,
                totalInterest: totalInterest,
                totalPayment: totalPayment + (isCappedCalculation ? bank.fee : 0) // 手續費只算一次(Primary算), Secondary如果也有手續費? 這裡假設補位不收或算在Primary
                // 修正：如果補位是另一家銀行，應該也要算手續費。但通常補位是"概念上"的。
                // 為了精確，若是 Combo，Secondary 的 calculateBankDetails 傳入 false (not capped calc) 會加 fee。
                // 我們在 combineResults 裡直接相加 totalPayment，所以這裡應該都要加 fee。
                // 等等，如果是同一個銀行拆兩單，fee 可能只收一次。
                // 如果是不同銀行，fee 收兩次。
                // 簡單起見：都加。
            }
        };
    }

    function getMacRateEndMonth(rates, index) {
        let totalYears = 0;
        for (let i = 0; i <= index; i++) {
            totalYears += rates[i].year;
        }
        return totalYears * 12;
    }

    // 4. 表格渲染
    function renderTable(results) {
        dom.tableBody.innerHTML = '';

        // Algorithm: Find Min Values for Recommendation
        const minFirstMonth = Math.min(...results.map(r => r.summary.firstMonthPayment));
        const minPostGrace = Math.min(...results.map(r => r.summary.firstPostGracePayment)); // New Metric
        const minTotal = Math.min(...results.map(r => r.summary.totalPayment));

        results.forEach((res, index) => {
            const tr = document.createElement('tr');

            // Badges
            let badges = '';
            // Threshold logic could be added here (e.g. within 1% of min)
            if (res.summary.firstMonthPayment === minFirstMonth) {
                badges += `<span class="badge badge-success">最低首期</span>`;
            }
            if (res.summary.firstPostGracePayment === minPostGrace) {
                // New Badge for Long Term Affordability
                badges += `<span class="badge" style="background-color: #8b5cf6; color: white; display: inline-block; margin-left: 4px;">最低月付</span>`;
            }
            if (res.summary.totalPayment === minTotal) {
                badges += `<span class="badge badge-primary">最低總額</span>`;
            }

            if (badges) {
                badges = `<div style="margin-bottom: 4px;">${badges}</div>`;
            }

            // 銀行名稱 (處理 Combo 顯示)
            let nameHtml = `${badges}<div style="font-weight: 500">${res.bank.name}</div>`;

            if (res.isCombo) {
                nameHtml += `<div style="font-size: 0.8em; color: var(--text-secondary); margin-top: 4px;">
                    組合：主約 ${res.bank.maxLoanAmount / 10000}萬 
                    ${res.secondaryBank ? `+ ${res.secondaryBank.name.split('｜')[0]} ${(res.gapAmount / 10000).toFixed(0)}萬` : '+ 額度不足'}
                </div>`;
            } else if (res.isCapped) {
                // Should not happen with new logic, but safe keep
                nameHtml += `<div style="font-size: 0.8em; color: var(--danger-color);">額度不足</div>`;
            } else {
                nameHtml += `<div style="font-size: 0.8em; color: var(--text-secondary); margin-top: 4px;">貸 ${res.effectivePrincipal / 10000} 萬 (足額)</div>`;
            }

            // 利率字串
            let rateStr = '';
            if (res.isCombo && res.secondaryBank) {
                rateStr = `主: ${res.bank.rates[0].rate}%<br>副: ${res.secondaryBank.rates[0].rate}% (混和)`;
            } else {
                rateStr = res.bank.rates.map(r => `${r.rate}% (${r.year}年)`).join('<br>');
            }

            // 寬限期內月付
            let gracePaymentStr = '-';
            // Logic: if combo, showing the combined payment
            if (res.summary.firstMonthPayment > 0) {
                gracePaymentStr = `<span class="amount-cell clickable-number" onclick="window.showDetail(${index}, 'grace_payment')">$${res.summary.firstMonthPayment.toLocaleString()}</span>`;
            }

            // 寬限期後月付 (Approx)
            // Just use the calculated one
            let postGracePaymentStr = `<span class="amount-cell clickable-number" onclick="window.showDetail(${index}, 'post_grace_payment')">$${res.summary.firstPostGracePayment.toLocaleString()}</span>`;


            tr.innerHTML = `
                <td>${nameHtml}</td>
                <td style="font-size: 0.9em; color: var(--text-secondary); line-height: 1.4;">${rateStr}</td>
                <td>${res.bank.gracePeriod} 年</td>
                <td>${gracePaymentStr}</td>
                <td>${postGracePaymentStr}</td>
                <td class="amount-cell clickable-number" onclick="window.showDetail(${index}, 'total_interest')">$${res.summary.totalInterest.toLocaleString()}</td>
                <td class="amount-cell clickable-number" onclick="window.showDetail(${index}, 'total_payment')" style="font-weight:700; color: var(--accent-color)">$${res.summary.totalPayment.toLocaleString()}</td>
            `;
            dom.tableBody.appendChild(tr);
        });
    }

    // Modal Handler
    window.showDetail = function (index, type) {
        const res = state.currentResults[index];
        if (!res) return;

        const modal = document.getElementById('detail-modal');
        const body = document.getElementById('modal-body-content');
        if (!modal || !body) return;

        let content = '';
        let title = '';

        // Helper for currency
        const fmt = n => '$' + n.toLocaleString();
        const fmtW = n => (n / 10000).toLocaleString() + '萬';

        if (type === 'grace_payment') {
            title = '寬限期內月付金計算';
            if (res.isCombo) {
                const pAcc = res.bank.maxLoanAmount;
                const pRate = res.bank.rates[0].rate;
                const gapAcc = res.gapAmount;
                const gapRate = res.secondaryBank.rates[0].rate;

                content = `
                    <div class="calc-row"><span class="calc-label">總貸款金額</span><span class="calc-value">${fmtW(state.loanAmount)}</span></div>
                    <div class="calc-row"><span class="calc-label">計算方式</span><span class="calc-value">主約 + 補位組合</span></div>
                    
                    <div class="calc-formula">
                        <div><strong>主約部分 (${res.bank.name.split('｜')[0]})</strong></div>
                        ${fmt(pAcc)} × ${pRate}% ÷ 12 = ${fmt(Math.round(pAcc * pRate / 100 / 12))}
                        <div style="margin-top:8px;"><strong>補位部分 (${res.secondaryBank.name.split('｜')[0]})</strong></div>
                        ${fmt(gapAcc)} × ${gapRate}% ÷ 12 = ${fmt(Math.round(gapAcc * gapRate / 100 / 12))}
                        <hr style="border-top:1px dashed #475569; margin:8px 0;">
                        <div style="text-align:right; color: var(--accent-color);">合計: ${fmt(res.summary.firstMonthPayment)}</div>
                    </div>
                `;
            } else {
                const rate = res.bank.rates[0].rate;
                content = `
                    <div class="calc-row"><span class="calc-label">貸款金額</span><span class="calc-value">${fmtW(res.effectivePrincipal)}</span></div>
                    <div class="calc-row"><span class="calc-label">首年利率</span><span class="calc-value">${rate}%</span></div>
                    
                    <div class="calc-formula">
                        (貸款金額 × 年利率) ÷ 12<br>
                        ${fmt(res.effectivePrincipal)} × ${rate}% ÷ 12<br>
                        = <strong>${fmt(res.summary.firstMonthPayment)}</strong>
                    </div>
                `;
            }
        }
        else if (type === 'post_grace_payment') {
            title = '寬限期後月付金 (本息攤還)';
            // Simplified explanation for amortization
            content = `
                <div class="calc-row"><span class="calc-label">還款方式</span><span class="calc-value">本息平均攤還</span></div>
                <div class="calc-formula">
                    此金額為「本息平均攤還」試算結果。<br>
                    包含本金與利息。由於各銀行年限與利率不同，系統以寬限期結束後的首月作為比較基準。
                    ${res.isCombo ? `<br><br><strong>此為組合貸款 (主約+補位) 之加總。</strong>` : ''}
                </div>
                <div class="calc-row" style="margin-top:10px;"><span class="calc-label">您需支付</span><span class="calc-value" style="color:var(--accent-color);">${fmt(res.summary.firstPostGracePayment)}</span></div>
            `;
        }
        else if (type === 'total_interest' || type === 'total_payment') {
            title = type === 'total_interest' ? '總利息支出' : '總還款金額 (含本金)';
            let details = '';
            if (res.isCombo) {
                const pInt = res.summary.totalInterest - (res.gapAmount * res.secondaryBank.rates[0].rate * 30 / 100); // Rough estimate? No, we don't have stored split.
                // Actually we summed them in combineResults but didn't store breakdown.
                // Hard to reconstruct exact interest split without re-calc. 
                // Let's just explain the logic.
                details = `此方案為組合貸款，總金額包含<br>1. <strong>${res.bank.name.split('｜')[0]}</strong> (主約)<br>2. <strong>${res.secondaryBank.name.split('｜')[0]}</strong> (補位)<br>之全期加總。`;
            } else {
                details = `此為全期 (${Math.max(res.bank.rates.reduce((a, b) => a + b.year, 0), 30)}年) 加總結果。`;
            }

            content = `
                <div class="calc-row"><span class="calc-label">項目</span><span class="calc-value">${type === 'total_interest' ? '累積利息' : '本金 + 利息 + 手續費'}</span></div>
                <div class="calc-formula">
                    ${details}<br>
                    ${type === 'total_payment' && res.bank.fee > 0 ? `*已包含手續費 $${res.bank.fee.toLocaleString()}` : ''}
                </div>
                <div class="calc-row" style="margin-top:10px;"><span class="calc-label">總計</span><span class="calc-value" style="color:var(--accent-color);">${fmt(type === 'total_interest' ? res.summary.totalInterest : res.summary.totalPayment)}</span></div>
            `;
        }

        document.querySelector('.modal-title').textContent = title;
        body.innerHTML = content;
        modal.classList.add('active');
    };

    // 5. D3 視覺化 - 動態過程演示 (Process Animation)
    function renderViz(results, fallbackBank) {
        const container = dom.vizContainer;
        if (!container) return;
        container.innerHTML = '';

        const margin = { top: 40, right: 100, bottom: 20, left: 160 }; // Increased Text Space
        const width = container.clientWidth - margin.left - margin.right;
        const height = Math.max(results.length * 50, 300); // Dynamic height
        container.style.height = `${height + margin.top + margin.bottom}px`;

        const svg = d3.select(container)
            .append("svg")
            .attr("width", width + margin.left + margin.right)
            .attr("height", height + margin.top + margin.bottom)
            .append("g")
            .attr("transform", `translate(${margin.left},${margin.top})`);

        // Scales
        const y = d3.scaleBand()
            .domain(results.map(d => d.bank.name))
            .range([0, height])
            .padding(0.4);

        const x = d3.scaleLinear()
            .domain([0, state.loanAmount * 1.05]) // Leave some space
            .range([0, width]);

        // Draw Y Axis
        svg.append("g")
            .call(d3.axisLeft(y).tickSize(0))
            .select(".domain").remove()
            .selectAll("text")
            .style("font-size", "14px")
            .style("font-weight", "500")
            .style("fill", "#334155");

        // Draw Background Grid (Target Line)
        svg.append("line")
            .attr("x1", x(state.loanAmount))
            .attr("x2", x(state.loanAmount))
            .attr("y1", 0)
            .attr("y2", height)
            .attr("stroke", "#cbd5e1")
            .attr("stroke-dasharray", "4")
            .attr("stroke-width", 1);

        svg.append("text")
            .attr("x", x(state.loanAmount))
            .attr("y", -10)
            .text(`目標: ${(state.loanAmount / 10000).toLocaleString()}萬`)
            .attr("text-anchor", "middle")
            .style("font-size", "12px")
            .style("fill", "#64748b");

        // Rows Container
        const rows = svg.selectAll(".row")
            .data(results)
            .join("g")
            .attr("class", "row")
            .attr("transform", d => `translate(0, ${y(d.bank.name)})`);

        // --- ANIMATION SEQUENCE ---

        // 1. Primary Bar (Grows from 0)
        const primaryBars = rows.append("rect")
            .attr("x", 0)
            .attr("y", 0)
            .attr("height", y.bandwidth())
            .attr("fill", "#3b82f6") // Blue
            .attr("width", 0) // Start at 0
            .attr("rx", 4);

        primaryBars.transition()
            .duration(1000)
            .ease(d3.easeCubicOut)
            .attr("width", d => x(d.isCombo ? d.bank.maxLoanAmount : d.effectivePrincipal));

        // 2. Gap Filling (Only for Combos)
        const secondaryBars = rows.filter(d => d.isCombo)
            .append("rect")
            .attr("x", d => x(d.bank.maxLoanAmount)) // Start at end of primary
            .attr("y", 0)
            .attr("height", y.bandwidth())
            .attr("fill", "#ef4444") // Start Red (Warning/Gap)
            .attr("width", 0) // Start empty
            .attr("rx", 4);

        // Sequence: Wait for primary to finish (1000ms), show gap warning, then fill
        secondaryBars.transition()
            .delay(1000)
            .duration(800)
            .attr("width", d => x(d.gapAmount)) // Expand to show gap
            .transition()
            .duration(500)
            .attr("fill", "#f59e0b"); // Turn Orange (Filled)

        // 3. Text Labels (Fade In)

        // Primary Label
        rows.append("text")
            .attr("x", 5)
            .attr("y", y.bandwidth() / 2)
            .attr("dy", ".35em")
            .style("fill", "white")
            .style("font-size", "11px")
            .style("opacity", 0)
            .text(d => (d.effectivePrincipal / 10000).toFixed(0))
            .transition()
            .delay(500)
            .style("opacity", function (d) { return d.isCombo ? 0 : 1; }); // Hide if combo initially, or simple logic

        // Combo Labels
        const comboLabels = rows.filter(d => d.isCombo)
            .append("g")
            .style("opacity", 0);

        comboLabels.transition().delay(2000).style("opacity", 1);

        comboLabels.append("text")
            .attr("x", d => x(d.bank.maxLoanAmount) + 5)
            .attr("y", y.bandwidth() / 2)
            .attr("dy", ".35em")
            .style("fill", "white")
            .style("font-size", "10px")
            .text(d => `+${d.secondaryBank.name.substr(0, 2)}`); // Show "Combined" name logic

        // Total Label at right
        rows.append("text")
            .attr("x", x(state.loanAmount) + 10)
            .attr("y", y.bandwidth() / 2)
            .attr("dy", ".35em")
            .style("fill", "#64748b")
            .style("font-size", "12px")
            .style("font-weight", "bold")
            .style("opacity", 0)
            .text(d => d.isCombo ? "完美組合" : "足額")
            .transition()
            .delay(2300)
            .style("opacity", 1);

    }


    // 6. 事件監聽
    // Navigation
    dom.navItems.forEach(item => {
        item.addEventListener('click', () => {
            dom.navItems.forEach(n => n.classList.remove('active'));
            dom.viewSections.forEach(v => {
                v.style.display = 'none';
                v.classList.remove('active');
            });
            item.classList.add('active');
            const targetId = item.dataset.target;
            const targetEl = document.getElementById(targetId);
            if (targetEl) {
                targetEl.style.display = 'block';
                setTimeout(() => {
                    targetEl.classList.add('active');
                    // Resize chart if switching to calculator view
                    if (targetId === 'calculator-view') {
                        calculateLoan();
                    }
                }, 10);
            }
        });
    });

    // Inputs
    const updateHandler = () => {
        state.totalPrice = parseFloat(dom.inputs.totalPrice.value) * 10000; // 萬 -> 元
        state.loanRatio = parseFloat(dom.inputs.loanRatio.value);
        if (isNaN(state.totalPrice) || isNaN(state.loanRatio)) return;
        calculateLoan();
    };

    dom.inputs.totalPrice.addEventListener('input', updateHandler);
    dom.inputs.loanRatio.addEventListener('input', updateHandler);


    // Init PDF List
    function initPdfList() {
        if (!window.LoanConfig.banks) return;
        dom.pdfList.innerHTML = ''; // Clear
        window.LoanConfig.banks.forEach(bank => {
            const li = document.createElement('li');
            li.textContent = bank.name;
            li.addEventListener('click', () => {
                Array.from(dom.pdfList.children).forEach(c => c.classList.remove('active'));
                li.classList.add('active');
                const pdfPath = `doc/${bank.filename}#toolbar=0&navpanes=0&scrollbar=0`;
                dom.pdfIframe.src = pdfPath;
                dom.pdfIframe.style.display = 'block';
                dom.pdfPlaceholder.style.display = 'none';
            });
            dom.pdfList.appendChild(li);
        });
    }

    // 7. 啟動
    function init() {
        // Set Default Inputs
        dom.inputs.totalPrice.value = state.totalPrice / 10000;
        dom.inputs.loanRatio.value = 75; // Explicit default

        initPdfList();
        calculateLoan();

        window.addEventListener('resize', calculateLoan);
    }

    init();
});
