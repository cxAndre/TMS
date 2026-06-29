async function extrairTudo() {
    let paginaAtual = 1;
    const PAGE_SIZE = 50;
    const urlBase = "https://qedb.ddns.net/swagger/api/ocorren/";
    
    let todasAsOcorrencias = [];
    let temMaisPaginas = true;
    let totalRegistrosEsperado = null;

    console.log("🚀 Iniciando extração total com Varredura Profunda Inteligente...");

    while (temMaisPaginas) {
        console.log(`-> Buscando página ${paginaAtual}...`);
        const urlComPaginacao = `${urlBase}?page=${paginaAtual}&pageSize=${PAGE_SIZE}`;

        try {
            const response = await fetch(urlComPaginacao, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                    "Authorization": "b03ea1b7e070da16093568af43f570eeb8bc1dcf142e320eeb8444f76f673b62" // Substitua pelo seu token real
                },
                body: JSON.stringify({
                    clientId: "1fd32e94bea05ca71c855009c3eafa08",
                    nfNumber: "",
                    outputFormat: "json",
                    layoutedi: "5.0",
                    dataI: "2026-05-01",
                    dataF: "2026-06-12",
                    page: paginaAtual,
                    pageSize: PAGE_SIZE,
                    ftp: 0
                })
            });

            if (!response.ok) {
                console.error(`❌ Erro na requisição da página ${paginaAtual}: Status ${response.status}`);
                break;
            }

            const json = await response.json();

            // --- FUNÇÃO DE VARREDURA PROFUNDA (Ignora qualquer camada/wrapper da API) ---
            let registrosEncontrados = [];
            let proximaPaginaFlag = null;

            function varrerObjeto(atual) {
                if (!atual || typeof atual !== 'object') return;

                // Se for um Array, varre cada elemento interno
                if (Array.isArray(atual)) {
                    for (let elemento of atual) {
                        varrerObjeto(elemento);
                    }
                    return;
                }

                // 1. Captura a lista de ocorrências
                if (Array.isArray(atual.ocorrencias)) {
                    registrosEncontrados = atual.ocorrencias;
                }

                // 2. Captura o total de registros do cabeçalho tradicional
                if (atual.header?.totalRegistros !== undefined) {
                    totalRegistrosEsperado = atual.header.totalRegistros;
                }

                // 3. Captura os metadados do bloco de paginação explícito da API
                if (atual.pagination) {
                    if (atual.pagination.totalRecords !== undefined) {
                        totalRegistrosEsperado = atual.pagination.totalRecords;
                    }
                    if (atual.pagination.hasNextPage !== undefined) {
                        proximaPaginaFlag = atual.pagination.hasNextPage;
                    }
                }

                // Varre as propriedades internas recursivamente
                for (let chave in atual) {
                    if (atual.hasOwnProperty(chave)) {
                        varrerObjeto(atual[chave]);
                    }
                }
            }

            // Executa a varredura no retorno da API
            varrerObjeto(json);

            // --- PROCESSAMENTO DOS RESULTADOS DA PÁGINA ---
            if (registrosEncontrados.length > 0) {
                todasAsOcorrencias.push(...registrosEncontrados);
                
                const indicadorTotal = totalRegistrosEsperado ? `/ ${totalRegistrosEsperado}` : "";
                console.log(`✓ Página ${paginaAtual} processada. Capturados nesta página: ${registrosEncontrados.length}. Total acumulado: ${todasAsOcorrencias.length} ${indicadorTotal}`);
            } else {
                console.log(`⚠️ Nenhum registro extraído na página ${paginaAtual} (Varredura retornou vazia).`);
                break; 
            }

            // --- VALIDAÇÃO DINÂMICA DE PRÓXIMA PÁGINA ---
            if (proximaPaginaFlag !== null) {
                // Se a API diz explicitamente no bloco 'pagination' se tem próxima, confiamos nela
                temMaisPaginas = proximaPaginaFlag && registrosEncontrados.length > 0;
            } else if (totalRegistrosEsperado !== null) {
                // Validação matemática secundária
                temMaisPaginas = todasAsOcorrencias.length < totalRegistrosEsperado && registrosEncontrados.length > 0;
            } else {
                // Validação padrão por tamanho de lote
                temMaisPaginas = registrosEncontrados.length === PAGE_SIZE;
            }

            if (temMaisPaginas) {
                paginaAtual++;
                await new Promise(resolve => setTimeout(resolve, 300)); // Pausa de estabilidade
            }

        } catch (error) {
            console.error(`❌ Erro crítico ao processar a página ${paginaAtual}:`, error.message);
            temMaisPaginas = false; 
        }
    }

    console.log(`==================================================`);
    console.log(`🏁 EXTRAÇÃO CONCLUÍDA!`);
    console.log(`Total de registros consolidados em memória: ${todasAsOcorrencias.length}`);
    
    if (totalRegistrosEsperado !== null) {
        console.log(`Total esperado informado pela API: ${totalRegistrosEsperado}`);
        if (todasAsOcorrencias.length === totalRegistrosEsperado) {
            console.log("✅ CONFIRMADO: 100% dos dados foram extraídos com sucesso de todas as 14 páginas!");
        } else {
            console.warn(`⚠️ ATENÇÃO: Inconsistência! Faltaram ${totalRegistrosEsperado - todasAsOcorrencias.length} registros.`);
        }
    }
    console.log(`==================================================`);
    
    // Gravação do arquivo final consolidade
    if (todasAsOcorrencias.length > 0) {
        const fs = require('fs');
        
        const resultadoFinal = [{
            clientId: "1fd32e94bea05ca71c855009c3eafa08",
            data: {
                header: {
                    version: "OCO50",
                    layout: "5.0",
                    totalRegistrosSalvos: todasAsOcorrencias.length,
                    totalRegistrosEsperados: totalRegistrosEsperado,
                    dataExtracao: new Date().toLocaleDateString('pt-BR')
                },
                ocorrencias: todasAsOcorrencias
            }
        }];

        fs.writeFileSync('dados_extraidos.json', JSON.stringify(resultadoFinal, null, 2));
        console.log("💾 Arquivo completo 'dados_extraidos.json' salvo com sucesso!");
    }
}

extrairTudo();