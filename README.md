# Video Creator Studio

Bom dia, tudo bem?

Preciso construir uma plataforma que vai criar vídeos para o Youtube. Essa plataforma deverá funcionar como se fosse um editor que irá montar o vídeo.

Use como tecnologia TypeScript + HTML + CSS.

A plataforma irá receber dados externos e terá o papel de pegar essas informações e montar o vídeo.

O fluxo é: carregar o roteiro > carregar as imagens > carregar a narração > gerar legenda > carrega música de fundo (controle do volume da música para não impactar na narração) > montar o vídeo > imagem de thumbnail com legenda.

Ou seja, a plataforma precisa permitir que o usuário faça o upload das informações que virão de fora (roteiro, imagens, música de fundo e narração).

A plataforma precisa permitir a lógica de pegar a duração da narração e dividir pela quantidade de imagens. Assim, cada imagem vai ficar na tela com o tempo dessa lógica. Exemplo: uma narração de 5 minutos e 40 segundos, vai produzir um vídeo de igual tempo onde cada imagem vai ficar na tela por aproximadamente 11 segundos e 17 milésimos de segundos.

A ideia é que essa plataforma seja como eu disse um editor que vai montar o vídeo com todos os elementos necessários.

A saída será um vídeo pronto e no formato que o Youtube aceita.

Faça um protótipo. Depois irei dar continuidade localmente.

This project was built with [Lovable](https://lovable.dev).

## Build with Lovable

Continue developing this project in the [Lovable editor](https://lovable.dev/projects/08048a2c-64ad-477d-96e9-5550665765f8).

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: every change made in Lovable is committed straight to this repository.
- **Full ownership**: this code is yours. Push to `main` on GitHub and your changes sync back into Lovable, ready for your next prompt.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```
